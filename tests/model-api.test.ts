import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FILE_NAME, readSettingsFile, type FileSettings } from "../src/config";
import { createMockEngine } from "../src/server/engine";
import { ProviderRequestError, type ProviderAccess, type ProviderModelLister } from "../src/server/provider-models";
import { startServer } from "../src/server/server";
import { createSettingsStore, type SettingsStore } from "../src/server/settings";
import { createStore } from "../src/server/store";
import type { ModelSettingsView, ProviderView } from "../src/shared/types";

/** 呼ばれた接続情報を記録し、返すモデルを差し替えられる一覧取得。 */
function createStubLister() {
  const accesses: ProviderAccess[] = [];
  let respond: () => Promise<readonly string[]> = async () => ["model-a", "model-b"];

  return {
    accesses,
    /** 次の取得で返す一覧、または投げる失敗を差し替える。 */
    setResponse(next: () => Promise<readonly string[]>) {
      respond = next;
    },
    listModels: (async (access: ProviderAccess) => {
      accesses.push(access);
      return await respond();
    }) as ProviderModelLister,
  };
}

type Harness = {
  request(path: string, init?: RequestInit): Promise<Response>;
  settings: SettingsStore;
  lister: ReturnType<typeof createStubLister>;
  /** 設定ファイルの中身。保存されたかどうかをここで確かめる。 */
  file(): FileSettings;
};

type ServerOptions = {
  /** 設定ファイルの置き場。既定は一時ディレクトリの直下。 */
  configPath?: (dir: string) => string;
};

/**
 * モデル設定の API を、実際の HTTP と本物の設定ファイルで確かめる。
 * モデル一覧の取得だけを差し替えるので、外部ネットワークには出ない。
 */
async function withModelServer<T>(
  initial: FileSettings | null,
  run: (harness: Harness) => Promise<T>,
  options: ServerOptions = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-model-"));
  const path = options.configPath?.(dir) ?? join(dir, CONFIG_FILE_NAME);
  if (initial !== null) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(initial)}\n`, "utf8");
  }

  const settings = createSettingsStore(path);
  const lister = createStubLister();
  const { server } = startServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      configDir: dir,
      configPath: path,
      dataDir: dir,
      dbPath: ":memory:",
      engine: "mock",
      isDevelopment: false,
    },
    store: createStore(":memory:"),
    engine: createMockEngine({ chunkSize: 10_000, delayMs: 0 }),
    settings,
    listModels: lister.listModels,
  });

  const harness: Harness = {
    request: (requestPath, init) => fetch(new URL(requestPath, server.url), init),
    settings,
    lister,
    file: () => readSettingsFile(path),
  };

  try {
    return await run(harness);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function providerView(harness: Harness, path: string, init: RequestInit): Promise<ModelSettingsView> {
  const response = await harness.request(path, init);
  expect(response.status, `失敗した: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as ModelSettingsView;
}

function findProvider(view: ModelSettingsView, id: string): ProviderView {
  const provider = view.providers.find((candidate) => candidate.id === id);
  if (provider === undefined) throw new Error(`プロバイダ ${id} が返っていない`);
  return provider;
}

describe("モデル設定 API", () => {
  test("設定が空なら、モデルもプロバイダも無い状態を返す", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request("/api/model");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ model: null, providers: [] });
    });
  });

  test("プロバイダを追加すると、API キーを返さずに設定へ書く", async () => {
    await withModelServer(null, async (harness) => {
      const view = await providerView(
        harness,
        "/api/model/providers",
        jsonRequest("POST", {
          id: "deepseek",
          apiKey: "sk-secret",
          baseUrl: null,
          label: null,
          defaultModel: "deepseek/model-a",
        }),
      );

      expect(view.model).toBe("deepseek/model-a");
      expect(findProvider(view, "deepseek")).toEqual({
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: null,
        hasApiKey: true,
      });
      // 応答のどこにも API キーが現れないこと。
      expect(JSON.stringify(view)).not.toContain("sk-secret");

      expect(harness.file().providers).toEqual({ deepseek: { apiKey: "sk-secret" } });
      expect(harness.file().model).toBe("deepseek/model-a");
      // 保存の前に、入力された資格で接続を確かめている。
      expect(harness.lister.accesses).toEqual([{ id: "deepseek", apiKey: "sk-secret", baseUrl: null }]);
    });
  });

  test("独自エンドポイントは名前と URL を持って追加できる", async () => {
    await withModelServer(null, async (harness) => {
      const view = await providerView(
        harness,
        "/api/model/providers",
        jsonRequest("POST", {
          id: "custom-1",
          apiKey: null,
          baseUrl: "http://127.0.0.1:1234/v1/",
          label: "社内ゲートウェイ",
          defaultModel: null,
        }),
      );

      expect(findProvider(view, "custom-1")).toEqual({
        id: "custom-1",
        name: "社内ゲートウェイ",
        baseUrl: "http://127.0.0.1:1234/v1",
        hasApiKey: false,
      });
      expect(harness.file().providers).toEqual({
        "custom-1": { baseUrl: "http://127.0.0.1:1234/v1", label: "社内ゲートウェイ" },
      });
    });
  });

  test("接続を確かめられないプロバイダは保存しない", async () => {
    await withModelServer(null, async (harness) => {
      harness.lister.setResponse(async () => {
        throw new ProviderRequestError("provider_auth_failed", "Invalid API key");
      });

      const response = await harness.request(
        "/api/model/providers",
        jsonRequest("POST", { id: "deepseek", apiKey: "sk-wrong", baseUrl: null, label: null, defaultModel: null }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toEqual({
        code: "provider_auth_failed",
        detail: "Invalid API key",
      });
      expect(harness.settings.read()).toEqual({ model: null, providers: {} });
      expect(harness.file().providers).toBeUndefined();
    });
  });

  test("到達できない場合は 502 で返し、保存しない", async () => {
    await withModelServer(null, async (harness) => {
      harness.lister.setResponse(async () => {
        throw new ProviderRequestError("provider_unreachable", "connect ECONNREFUSED");
      });

      const response = await harness.request(
        "/api/model/providers",
        jsonRequest("POST", {
          id: "custom-1",
          apiKey: null,
          baseUrl: "http://127.0.0.1:9/v1",
          label: "だめなやつ",
          defaultModel: null,
        }),
      );

      expect(response.status).toBe(502);
      expect(((await response.json()) as { code: string }).code).toBe("provider_unreachable");
      expect(harness.file().providers).toBeUndefined();
    });
  });

  test("すでにあるプロバイダは 409 で断る", async () => {
    await withModelServer({ providers: { deepseek: { apiKey: "sk-1" } } }, async (harness) => {
      const response = await harness.request(
        "/api/model/providers",
        jsonRequest("POST", { id: "deepseek", apiKey: "sk-2", baseUrl: null, label: null, defaultModel: null }),
      );

      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("provider_exists");
      expect(harness.file().providers).toEqual({ deepseek: { apiKey: "sk-1" } });
    });
  });

  test("既知のプロバイダに API キーが無ければ 400 で断る（勝手に環境変数へは委ねない）", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/providers",
        jsonRequest("POST", { id: "deepseek", apiKey: null, baseUrl: null, label: null, defaultModel: null }),
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
      expect(harness.lister.accesses).toEqual([]);
    });
  });

  test("独自エンドポイントに URL が無ければ 400 で断る", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/providers",
        jsonRequest("POST", { id: "custom-1", apiKey: null, baseUrl: null, label: "名無し", defaultModel: null }),
      );

      expect(response.status).toBe(400);
      expect(harness.lister.accesses).toEqual([]);
    });
  });

  test("保存せずに接続だけを確かめられる", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/check",
        jsonRequest("POST", { id: "deepseek", apiKey: "sk-check", baseUrl: null, label: null }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ models: ["model-a", "model-b"] });
      expect(harness.settings.read()).toEqual({ model: null, providers: {} });
      expect(harness.lister.accesses).toEqual([{ id: "deepseek", apiKey: "sk-check", baseUrl: null }]);
    });
  });

  test("保存済みのプロバイダのモデル一覧は、保存済みの資格で取る", async () => {
    await withModelServer({ providers: { deepseek: { apiKey: "sk-saved" } } }, async (harness) => {
      const response = await harness.request("/api/model/providers/deepseek/models");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ models: ["model-a", "model-b"] });
      expect(harness.lister.accesses).toEqual([{ id: "deepseek", apiKey: "sk-saved", baseUrl: null }]);
    });
  });

  test("設定に無いプロバイダのモデル一覧は 404", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request("/api/model/providers/deepseek/models");

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("provider_not_found");
    });
  });

  test("API キーを入れ替えられる", async () => {
    await withModelServer({ providers: { deepseek: { apiKey: "sk-old" } } }, async (harness) => {
      const view = await providerView(
        harness,
        "/api/model/providers/deepseek",
        jsonRequest("PATCH", { apiKey: "sk-new", baseUrl: null, label: null }),
      );

      expect(view.providers).toHaveLength(1);
      expect(harness.file().providers).toEqual({ deepseek: { apiKey: "sk-new" } });
      expect(harness.lister.accesses).toEqual([{ id: "deepseek", apiKey: "sk-new", baseUrl: null }]);
    });
  });

  test("API キーを空で送ると、保存済みのキーをそのまま使う", async () => {
    await withModelServer({ providers: { "custom-1": { baseUrl: "https://gw.example.test/v1", apiKey: "sk-old", label: "社内" } } }, async (harness) => {
      const view = await providerView(
        harness,
        "/api/model/providers/custom-1",
        jsonRequest("PATCH", { apiKey: null, baseUrl: "https://gw.example.test/v2", label: "社内" }),
      );

      expect(findProvider(view, "custom-1").baseUrl).toBe("https://gw.example.test/v2");
      expect(harness.file().providers).toEqual({
        "custom-1": { baseUrl: "https://gw.example.test/v2", apiKey: "sk-old", label: "社内" },
      });
      expect(harness.lister.accesses).toEqual([
        { id: "custom-1", apiKey: "sk-old", baseUrl: "https://gw.example.test/v2" },
      ]);
    });
  });

  test("設定に無いプロバイダの変更は 404", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/providers/deepseek",
        jsonRequest("PATCH", { apiKey: "sk-1", baseUrl: null, label: null }),
      );

      expect(response.status).toBe(404);
      expect(harness.lister.accesses).toEqual([]);
    });
  });

  test("プロバイダを削除できる。既定のモデルはそのまま残る", async () => {
    await withModelServer(
      { model: "deepseek/model-a", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        const response = await harness.request("/api/model/providers/deepseek", { method: "DELETE" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ model: "deepseek/model-a", providers: [] });

        // 消えたプロバイダのモデルは設定に残る。画面が「使えない」と伝え、選び直しを促す。
        expect(harness.file().model).toBe("deepseek/model-a");
        expect(harness.file().providers).toEqual({});

        expect((await harness.request("/api/model/providers/deepseek", { method: "DELETE" })).status).toBe(404);
      },
    );
  });

  test("既定のモデルを変えられる", async () => {
    await withModelServer(
      { model: "deepseek/model-a", providers: { deepseek: { apiKey: "sk-1" }, ollama: { baseUrl: "http://127.0.0.1:11434/v1" } } },
      async (harness) => {
        const view = await providerView(harness, "/api/model", jsonRequest("PUT", { model: "ollama/llama3.1" }));

        expect(view.model).toBe("ollama/llama3.1");
        expect(harness.file().model).toBe("ollama/llama3.1");
      },
    );
  });

  test("設定に無いプロバイダのモデルは既定にできない", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request("/api/model", jsonRequest("PUT", { model: "deepseek/model-a" }));

      expect(response.status).toBe(400);
      expect(harness.file().model).toBeUndefined();
    });
  });

  test("設定を書けないときは、その旨を返す", async () => {
    // 置き場のディレクトリごと無い状態にして、接続確認までは通るが保存だけが失敗する形にする。
    await withModelServer(
      null,
      async (harness) => {
        const response = await harness.request(
          "/api/model/providers",
          jsonRequest("POST", {
            id: "custom-1",
            apiKey: null,
            baseUrl: "http://127.0.0.1:4321/v1",
            label: "書けないやつ",
            defaultModel: null,
          }),
        );

        expect(response.status).toBe(500);
        const body = (await response.json()) as { code: string; detail: string };
        expect(body.code).toBe("settings_write_failed");
        expect(body.detail.length).toBeGreaterThan(0);
        // 書き込みに失敗したので、設定は空のまま。
        expect(harness.settings.read()).toEqual({ model: null, providers: {} });
      },
      { configPath: (dir) => join(dir, "missing", CONFIG_FILE_NAME) },
    );
  });

  test("モデルが未設定なら、送信はセッションを作らずに断る", async () => {
    await withModelServer({ providers: { deepseek: { apiKey: "sk-1" } } }, async (harness) => {
      const response = await harness.request(
        "/api/sessions/s1/messages",
        jsonRequest("POST", { content: "こんにちは" }),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; detail: string };
      expect(body.code).toBe("model_not_configured");
      expect(body.detail).toContain("既定のモデル");

      const sessions = await harness.request("/api/sessions");
      expect(await sessions.json()).toEqual({ sessions: [] });
    });
  });

  test("モデルが設定されていれば、これまでどおり送信できる", async () => {
    await withModelServer(
      { model: "deepseek/model-a", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        const response = await harness.request(
          "/api/sessions/s1/messages",
          jsonRequest("POST", { content: "こんにちは" }),
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("user-message");
      },
    );
  });
});

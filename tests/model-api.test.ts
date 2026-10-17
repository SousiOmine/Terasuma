import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FILE_NAME, readSettingsFile, type FileSettings } from "../src/config";
import { createMockEngine } from "../src/server/engine";
import { parseCatalog, type Catalog, type CatalogSnapshot } from "../src/server/models-dev";
import {
  ProviderRequestError,
  type ConnectionChecker,
  type ProviderModelLister,
  type ProviderRequest,
} from "../src/server/provider-models";
import { startServer } from "../src/server/server";
import type { ProviderCheckResult } from "../src/shared/types";
import { createSettingsStore, type SettingsStore } from "../src/server/settings";
import { createStore, DEFAULT_TERA_ID } from "../src/server/store";
import { createHandover } from "../src/server/handover";
import { createContainerStub, createMcpStub, createMemoryStub } from "./support";
import type { ModelSettingsView, ProviderView, ReasoningView } from "../src/shared/types";

/** テストで使うカタログの中身。deepseek はカタログのプロバイダ、custom-1 は独自エンドポイント。 */
const CATALOG_RAW = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "deepseek-flash": {
        id: "deepseek-flash",
        name: "DeepSeek Flash",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
      // 思考強度を持たないモデル。
      "deepseek-v3": { id: "deepseek-v3", name: "DeepSeek V3" },
    },
  },
};

/** カタログの差し替え。取得に失敗させることもできる。 */
function createCatalogStub() {
  const snapshot: CatalogSnapshot = parseCatalog(CATALOG_RAW, 1_000);
  let failure: Error | null = null;

  return {
    snapshot,
    fail(error: Error) {
      failure = error;
    },
    catalog: {
      snapshot: () => (failure === null ? snapshot : null),
      load: async () => {
        if (failure !== null) throw failure;
        return snapshot;
      },
    } satisfies Catalog,
  };
}

/** 接続確認の差し替え。呼ばれた宛先と資格を記録する。 */
function createCheckStub() {
  const requests: ProviderRequest[] = [];
  let respond: () => Promise<ProviderCheckResult> = async () => ({ verified: true, models: ["model-a", "model-b"] });

  return {
    requests,
    setResponse(next: () => Promise<ProviderCheckResult>) {
      respond = next;
    },
    checkConnection: (async (request: ProviderRequest) => {
      // signal は比較できないので記録しない。
      requests.push({ target: request.target, apiKey: request.apiKey });
      return await respond();
    }) as ConnectionChecker,
  };
}

/** 独自エンドポイントのモデル一覧の差し替え。 */
function createListerStub() {
  const requests: ProviderRequest[] = [];
  let respond: () => Promise<readonly string[]> = async () => ["qwen3-max"];

  return {
    requests,
    setResponse(next: () => Promise<readonly string[]>) {
      respond = next;
    },
    listModels: (async (request: ProviderRequest) => {
      requests.push({ target: request.target, apiKey: request.apiKey });
      return await respond();
    }) as ProviderModelLister,
  };
}

type Harness = {
  request(path: string, init?: RequestInit): Promise<Response>;
  settings: SettingsStore;
  catalog: ReturnType<typeof createCatalogStub>;
  check: ReturnType<typeof createCheckStub>;
  lister: ReturnType<typeof createListerStub>;
  /** 設定ファイルの中身。保存されたかどうかをここで確かめる。 */
  file(): FileSettings;
};

type ServerOptions = {
  /** 設定ファイルの置き場。既定は一時ディレクトリの直下。 */
  configPath?: (dir: string) => string;
};

/**
 * モデル設定の API を、実際の HTTP と本物の設定ファイルで確かめる。
 * カタログと接続確認だけを差し替えるので、外部ネットワークには出ない。
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
  const catalog = createCatalogStub();
  const check = createCheckStub();
  const lister = createListerStub();
  const store = createStore(":memory:");
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
    store,
    engine: createMockEngine({ chunkSize: 10_000, delayMs: 0 }),
    memory: createMemoryStub(store),
    settings,
    mcp: createMcpStub(),
    container: createContainerStub(),
    handover: createHandover(),
    catalog: catalog.catalog,
    checkConnection: check.checkConnection,
    listModels: lister.listModels,
  });

  const harness: Harness = {
    request: (requestPath, init) => fetch(new URL(requestPath, server.url), init),
    settings,
    catalog,
    check,
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

async function settingsView(harness: Harness, path: string, init: RequestInit): Promise<ModelSettingsView> {
  const response = await harness.request(path, init);
  expect(response.status, `失敗した: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as ModelSettingsView;
}

async function reasoningView(harness: Harness, init?: RequestInit): Promise<ReasoningView> {
  const response = await harness.request("/api/model/reasoning", init);
  expect(response.status, `失敗した: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as ReasoningView;
}

function findProvider(view: ModelSettingsView, id: string): ProviderView {
  const provider = view.providers.find((candidate) => candidate.id === id);
  if (provider === undefined) throw new Error(`プロバイダ ${id} が返っていない`);
  return provider;
}

const DEEPSEEK_CHECK: ProviderRequest = {
  target: { url: "https://api.deepseek.com/models", auth: "bearer" },
  apiKey: "sk-secret",
};

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
      const view = await settingsView(
        harness,
        "/api/model/providers",
        jsonRequest("POST", {
          id: "deepseek",
          apiKey: "sk-secret",
          baseUrl: null,
          label: null,
          defaultModel: "deepseek/deepseek-flash",
        }),
      );

      expect(view.model).toBe("deepseek/deepseek-flash");
      // 表示名はカタログから当てるので、保存するのは id だけ。
      expect(findProvider(view, "deepseek")).toEqual({
        id: "deepseek",
        name: "deepseek",
        baseUrl: null,
        hasApiKey: true,
      });
      // 応答のどこにも API キーが現れないこと。
      expect(JSON.stringify(view)).not.toContain("sk-secret");

      expect(harness.file().providers).toEqual({ deepseek: { apiKey: "sk-secret" } });
      expect(harness.file().model).toBe("deepseek/deepseek-flash");
      // 保存の前に、カタログの api を宛先にして接続を確かめている。
      expect(harness.check.requests).toEqual([DEEPSEEK_CHECK]);
    });
  });

  test("独自エンドポイントは名前と URL を持って追加できる", async () => {
    await withModelServer(null, async (harness) => {
      const view = await settingsView(
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
      expect(harness.check.requests[0]?.target).toEqual({
        url: "http://127.0.0.1:1234/v1/models",
        auth: "bearer",
      });
    });
  });

  test("独自エンドポイントは複数登録できる", async () => {
    await withModelServer(null, async (harness) => {
      await settingsView(
        harness,
        "/api/model/providers",
        jsonRequest("POST", {
          id: "custom-1",
          apiKey: null,
          baseUrl: "http://127.0.0.1:1234/v1",
          label: "社内ゲートウェイ",
          defaultModel: null,
        }),
      );

      const view = await settingsView(
        harness,
        "/api/model/providers",
        jsonRequest("POST", {
          id: "custom-2",
          apiKey: "sk-second",
          baseUrl: "http://127.0.0.1:1235/v1",
          label: "別のゲートウェイ",
          defaultModel: "custom-2/qwen3-max",
        }),
      );

      // 2 つとも残り、それぞれ別の接続先を持つ。
      expect(view.providers.map((provider) => provider.id)).toEqual(["custom-1", "custom-2"]);
      expect(harness.file().providers).toEqual({
        "custom-1": { baseUrl: "http://127.0.0.1:1234/v1", label: "社内ゲートウェイ" },
        "custom-2": { baseUrl: "http://127.0.0.1:1235/v1", label: "別のゲートウェイ", apiKey: "sk-second" },
      });
      expect(harness.file().model).toBe("custom-2/qwen3-max");
    });
  });

  test("接続を確かめられないプロバイダは保存しない", async () => {
    await withModelServer(null, async (harness) => {
      harness.check.setResponse(async () => {
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
      expect(harness.settings.read()).toEqual({ model: null, providers: {}, modelOptions: {} });
      expect(harness.file().providers).toBeUndefined();
    });
  });

  test("一覧を公開していないプロバイダは、確認できなくても保存できる", async () => {
    await withModelServer(null, async (harness) => {
      harness.check.setResponse(async () => ({ verified: false, models: [] }));

      const view = await settingsView(
        harness,
        "/api/model/providers",
        jsonRequest("POST", { id: "deepseek", apiKey: "sk-1", baseUrl: null, label: null, defaultModel: null }),
      );

      expect(findProvider(view, "deepseek").hasApiKey).toBe(true);
      expect(harness.file().providers).toEqual({ deepseek: { apiKey: "sk-1" } });
    });
  });

  test("到達できない場合は 502 で返し、保存しない", async () => {
    await withModelServer(null, async (harness) => {
      harness.check.setResponse(async () => {
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

  test("カタログのプロバイダに API キーが無ければ 400 で断る（勝手に環境変数へは委ねない）", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/providers",
        jsonRequest("POST", { id: "deepseek", apiKey: null, baseUrl: null, label: null, defaultModel: null }),
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
      expect(harness.check.requests).toEqual([]);
    });
  });

  test("カタログに無い id に URL が無ければ 400 で断る", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/providers",
        jsonRequest("POST", { id: "custom-1", apiKey: null, baseUrl: null, label: "名無し", defaultModel: null }),
      );

      expect(response.status).toBe(400);
      expect(harness.check.requests).toEqual([]);
    });
  });

  test("保存せずに接続だけを確かめられる", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/check",
        jsonRequest("POST", { id: "deepseek", apiKey: "sk-check", baseUrl: null, label: null }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ verified: true, models: ["model-a", "model-b"] });
      expect(harness.settings.read()).toEqual({ model: null, providers: {}, modelOptions: {} });
      expect(harness.check.requests).toEqual([{ ...DEEPSEEK_CHECK, apiKey: "sk-check" }]);
    });
  });

  test("保存済みのプロバイダのモデル一覧は、カタログから取る", async () => {
    await withModelServer({ providers: { deepseek: { apiKey: "sk-saved" } } }, async (harness) => {
      const response = await harness.request("/api/model/providers/deepseek/models");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        models: ["deepseek-flash", "deepseek-v3", "deepseek-v4-pro"],
      });
      // カタログから取るので、プロバイダへは問い合わせない。
      expect(harness.lister.requests).toEqual([]);
    });
  });

  test("独自エンドポイントのモデル一覧は /models から取る", async () => {
    await withModelServer(
      { providers: { "custom-1": { baseUrl: "http://127.0.0.1:1234/v1" } } },
      async (harness) => {
        const response = await harness.request("/api/model/providers/custom-1/models");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ models: ["qwen3-max"] });
        expect(harness.lister.requests[0]?.target).toEqual({
          url: "http://127.0.0.1:1234/v1/models",
          auth: "bearer",
        });
      },
    );
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
      const view = await settingsView(
        harness,
        "/api/model/providers/deepseek",
        jsonRequest("PATCH", { apiKey: "sk-new", baseUrl: null, label: null }),
      );

      expect(view.providers).toHaveLength(1);
      expect(harness.file().providers).toEqual({ deepseek: { apiKey: "sk-new" } });
      expect(harness.check.requests).toEqual([{ ...DEEPSEEK_CHECK, apiKey: "sk-new" }]);
    });
  });

  test("API キーを空で送ると、保存済みのキーをそのまま使う", async () => {
    await withModelServer(
      {
        providers: {
          "custom-1": { baseUrl: "https://gw.example.test/v1", apiKey: "sk-old", label: "社内" },
        },
      },
      async (harness) => {
        const view = await settingsView(
          harness,
          "/api/model/providers/custom-1",
          jsonRequest("PATCH", { apiKey: null, baseUrl: "https://gw.example.test/v2", label: "社内" }),
        );

        expect(findProvider(view, "custom-1").baseUrl).toBe("https://gw.example.test/v2");
        expect(harness.file().providers).toEqual({
          "custom-1": { baseUrl: "https://gw.example.test/v2", apiKey: "sk-old", label: "社内" },
        });
        expect(harness.check.requests[0]?.target).toEqual({
          url: "https://gw.example.test/v2/models",
          auth: "bearer",
        });
      },
    );
  });

  test("API キーを空文字で送っても、保存済みのキーをそのまま使う", async () => {
    await withModelServer(
      {
        providers: {
          "custom-1": { baseUrl: "https://gw.example.test/v1", apiKey: "sk-old", label: "社内" },
        },
      },
      async (harness) => {
        const view = await settingsView(
          harness,
          "/api/model/providers/custom-1",
          jsonRequest("PATCH", { apiKey: "", baseUrl: "https://gw.example.test/v1", label: "社内" }),
        );

        expect(findProvider(view, "custom-1").hasApiKey).toBe(true);
        expect(harness.file().providers).toEqual({
          "custom-1": { baseUrl: "https://gw.example.test/v1", apiKey: "sk-old", label: "社内" },
        });
      },
    );
  });

  test("設定に無いプロバイダの変更は 404", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/providers/deepseek",
        jsonRequest("PATCH", { apiKey: "sk-1", baseUrl: null, label: null }),
      );

      expect(response.status).toBe(404);
      expect(harness.check.requests).toEqual([]);
    });
  });

  test("プロバイダを削除できる。既定のモデルはそのまま残る", async () => {
    await withModelServer(
      { model: "deepseek/deepseek-flash", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        const response = await harness.request("/api/model/providers/deepseek", { method: "DELETE" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ model: "deepseek/deepseek-flash", providers: [] });

        // 消えたプロバイダのモデルは設定に残る。画面が「使えない」と伝え、選び直しを促す。
        expect(harness.file().model).toBe("deepseek/deepseek-flash");
        expect(harness.file().providers).toEqual({});

        expect((await harness.request("/api/model/providers/deepseek", { method: "DELETE" })).status).toBe(404);
      },
    );
  });

  test("既定のモデルを変えられる", async () => {
    await withModelServer(
      {
        model: "deepseek/deepseek-flash",
        providers: { deepseek: { apiKey: "sk-1" }, "custom-1": { baseUrl: "http://127.0.0.1:1234/v1" } },
      },
      async (harness) => {
        const view = await settingsView(
          harness,
          "/api/model",
          jsonRequest("PUT", { model: "custom-1/qwen3-max" }),
        );

        expect(view.model).toBe("custom-1/qwen3-max");
        expect(harness.file().model).toBe("custom-1/qwen3-max");
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
        expect(harness.settings.read()).toEqual({ model: null, providers: {}, modelOptions: {} });
      },
      { configPath: (dir) => join(dir, "missing", CONFIG_FILE_NAME) },
    );
  });
});

describe("カタログ API", () => {
  test("カタログのプロバイダを名前つきで返す", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request("/api/model/catalog");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        providers: [{ id: "deepseek", name: "DeepSeek", models: 3 }],
      });
    });
  });

  test("カタログのプロバイダのモデル一覧を返す", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request("/api/model/catalog/deepseek/models");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        models: ["deepseek-flash", "deepseek-v3", "deepseek-v4-pro"],
      });
    });
  });

  test("カタログに無いプロバイダは 404", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request("/api/model/catalog/unknown/models");

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("provider_not_found");
    });
  });

  test("カタログを取得できないときは、その旨を返す", async () => {
    await withModelServer(null, async (harness) => {
      harness.catalog.fail(new Error("offline"));

      const response = await harness.request("/api/model/catalog");

      expect(response.status).toBe(502);
      const body = (await response.json()) as { code: string; detail: string };
      expect(body.code).toBe("catalog_unavailable");
      expect(body.detail).toContain("offline");
    });
  });
});

describe("思考強度", () => {
  test("既定のモデルの思考強度と、選べる値を返す", async () => {
    await withModelServer(
      { model: "deepseek/deepseek-v4-pro", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        expect(await reasoningView(harness)).toEqual({
          model: "deepseek/deepseek-v4-pro",
          effort: null,
          values: ["low", "high", "max"],
        });
      },
    );
  });

  test("モデルが未設定なら、選ぶものは無い", async () => {
    await withModelServer(null, async (harness) => {
      expect(await reasoningView(harness)).toEqual({ model: null, effort: null, values: [] });
    });
  });

  test("思考強度を持たないモデルでは、選べる値が空になる", async () => {
    await withModelServer(
      { model: "deepseek/deepseek-v3", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        expect(await reasoningView(harness)).toEqual({ model: "deepseek/deepseek-v3", effort: null, values: [] });
      },
    );
  });

  test("設定した思考強度は、モデルごとに残って切り替えても戻る", async () => {
    await withModelServer(
      { model: "deepseek/deepseek-v4-pro", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        const changed = await reasoningView(
          harness,
          jsonRequest("PUT", { reasoningEffort: "high" }),
        );
        expect(changed.effort).toBe("high");
        expect(harness.file().modelOptions).toEqual({
          "deepseek/deepseek-v4-pro": { reasoningEffort: "high" },
        });

        // 別のモデルへ切り替えると、そのモデルの値（未設定）が返る。
        await harness.request("/api/model", jsonRequest("PUT", { model: "deepseek/deepseek-flash" }));
        expect((await reasoningView(harness)).effort).toBeNull();

        await reasoningView(harness, jsonRequest("PUT", { reasoningEffort: "low" }));
        expect(harness.file().modelOptions).toEqual({
          "deepseek/deepseek-v4-pro": { reasoningEffort: "high" },
          "deepseek/deepseek-flash": { reasoningEffort: "low" },
        });

        // 元のモデルへ戻すと、前の値が戻っている。
        await harness.request("/api/model", jsonRequest("PUT", { model: "deepseek/deepseek-v4-pro" }));
        expect((await reasoningView(harness)).effort).toBe("high");
      },
    );
  });

  test("未設定へ戻せる", async () => {
    await withModelServer(
      {
        model: "deepseek/deepseek-v4-pro",
        providers: { deepseek: { apiKey: "sk-1" } },
        modelOptions: { "deepseek/deepseek-v4-pro": { reasoningEffort: "high" } },
      },
      async (harness) => {
        const view = await reasoningView(harness, jsonRequest("PUT", { reasoningEffort: null }));

        expect(view.effort).toBeNull();
        expect(harness.file().modelOptions).toEqual({});
      },
    );
  });

  test("モデルが受け付けない値は 400 で断る", async () => {
    await withModelServer(
      { model: "deepseek/deepseek-v4-pro", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        const response = await harness.request(
          "/api/model/reasoning",
          jsonRequest("PUT", { reasoningEffort: "medium" }),
        );

        expect(response.status).toBe(400);
        expect(((await response.json()) as { detail: string }).detail).toContain("low, high, max");
        expect(harness.file().modelOptions).toBeUndefined();
      },
    );
  });

  test("思考強度を指定できないモデルでは 400 で断る", async () => {
    await withModelServer(
      { model: "deepseek/deepseek-v3", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        const response = await harness.request(
          "/api/model/reasoning",
          jsonRequest("PUT", { reasoningEffort: "high" }),
        );

        expect(response.status).toBe(400);
        expect(((await response.json()) as { detail: string }).detail).toContain("指定できません");
      },
    );
  });

  test("モデルが未設定なら 400 で断る", async () => {
    await withModelServer(null, async (harness) => {
      const response = await harness.request(
        "/api/model/reasoning",
        jsonRequest("PUT", { reasoningEffort: "high" }),
      );

      expect(response.status).toBe(400);
      expect(harness.file().modelOptions).toBeUndefined();
    });
  });
});

describe("チャットとモデル設定の関係", () => {
  test("モデルが未設定なら、送信はターンを始めずに断る", async () => {
    await withModelServer({ providers: { deepseek: { apiKey: "sk-1" } } }, async (harness) => {
      const response = await harness.request(
        `/api/teras/${DEFAULT_TERA_ID}/messages`,
        jsonRequest("POST", { content: "こんにちは" }),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; detail: string };
      expect(body.code).toBe("model_not_configured");
      expect(body.detail).toContain("既定のモデル");

      // Tera は既定の 1 体のままで、履歴も空のまま。
      const teras = await harness.request("/api/teras");
      const listed = (await teras.json()) as { teras: { id: string }[] };
      expect(listed.teras.map((tera) => tera.id)).toEqual([DEFAULT_TERA_ID]);

      const messages = await harness.request(`/api/teras/${DEFAULT_TERA_ID}/messages`);
      expect(await messages.json()).toEqual({ messages: [] });
    });
  });

  test("モデルが設定されていれば、これまでどおり送信できる", async () => {
    await withModelServer(
      { model: "deepseek/deepseek-flash", providers: { deepseek: { apiKey: "sk-1" } } },
      async (harness) => {
        const response = await harness.request(
          `/api/teras/${DEFAULT_TERA_ID}/messages`,
          jsonRequest("POST", { content: "こんにちは" }),
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("user-message");
      },
    );
  });
});

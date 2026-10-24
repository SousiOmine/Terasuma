import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { WORKDIR_IN_CONTAINER } from "../src/server/computer/contract";
import {
  createConnectors,
  type ConnectorScriptResult,
  type ConnectorsManager,
} from "../src/server/connectors/manager";
import type { PiRuntime } from "../src/server/connectors/pi";
import { ConnectorNotFound } from "../src/server/errors";
import { withTempDir } from "./harness";
import {
  fakeProgramProvider,
  fakeProvider,
  startFakeConnectorServer,
  type FakeConnectorServer,
} from "./fixtures/connector-server";

/**
 * コネクタ（トークン）。
 * トークンは偽の API サーバーで検証し、待ちは setToken で解く。
 * Discord は Tera ごとの webhook なので、ここではなく tests/discord.test.ts が確かめる。
 */

type Context = {
  manager: ConnectorsManager;
  dir: string;
  server: FakeConnectorServer;
};

/** 偽の接続先と、一時ディレクトリのトークン置き場を用意する。 */
async function withConnectors(run: (context: Context) => Promise<void>): Promise<void> {
  const server = startFakeConnectorServer();
  try {
    await withTempDir("terasuma-connectors-", async (dir) => {
      const manager = createConnectors({ dataDir: join(dir, "data"), providers: [fakeProvider(server)] });

      try {
        await run({ manager, dir, server });
      } finally {
        manager.close();
      }
    });
  } finally {
    await server.server.stop(true);
  }
}

/** ターンが続いている状態の signal。 */
function signal(): AbortSignal {
  return new AbortController().signal;
}

/**
 * 失敗するまで待って、理由を 1 文で返す。
 * Bun 1.4.3 の expect(...).rejects は未解決の promise を待ってくれるが、
 * その場で待ちに入ってしまうため、トリガーより前に呼ぶテストでは使えない。
 */
function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "(resolved)",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("コネクタ", () => {
  test("トークンを保存すると、接続済みになり環境変数に載る", async () => {
    await withConnectors(async ({ manager, dir, server }) => {
      const view = await manager.setToken("github", server.accessToken);

      expect(view.providers[0]).toMatchObject({
        connected: true,
        account: server.account,
        detail: null,
      });

      // コンピュータへ渡す値と、画面に出すアカウント。
      expect(manager.env()).toEqual({ GH_TOKEN: server.accessToken, GITHUB_TOKEN: server.accessToken });

      // トークンは本人だけが読める権限で保存する。
      const tokenPath = join(dir, "data", "connectors", "github.json");
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

      const connected = await manager.wait("github", signal());
      expect(connected).toContain(`@${server.account}`);
      expect(connected).toContain("$GH_TOKEN");
    });
  });

  test("受け付けられないトークンは保存しない", async () => {
    await withConnectors(async ({ manager, dir }) => {
      expect(await rejectionOf(manager.setToken("github", "wrong"))).toMatch(/did not accept the token/);

      expect(manager.token("github")).toBeNull();
      expect(existsSync(join(dir, "data", "connectors", "github.json"))).toBe(false);
    });
  });

  test("トークンが無ければ、保存を待つ", async () => {
    await withConnectors(async ({ manager }) => {
      const waiting = manager.wait("github", signal());
      const rejected = rejectionOf(waiting);

      manager.cancelWait("github");
      expect(await rejected).toMatch(/cancelled/);
    });
  });

  test("同じアプリの待ちは、トークン保存でまとめて解ける", async () => {
    await withConnectors(async ({ manager, server }) => {
      const first = manager.wait("github", signal());
      const second = manager.wait("github", signal());

      await manager.setToken("github", server.accessToken);

      expect(await first).toContain(`@${server.account}`);
      expect(await second).toContain(`@${server.account}`);
    });
  });

  test("ターンが止まると、待ちは外れる", async () => {
    await withConnectors(async ({ manager }) => {
      const controller = new AbortController();
      const waiting = manager.wait("github", controller.signal);
      const rejected = rejectionOf(waiting);

      controller.abort();
      expect(await rejected).toMatch(/turn ended/);
    });
  });

  test("接続済みなら、待たずに使い方を返す", async () => {
    await withConnectors(async ({ manager, server }) => {
      await manager.setToken("github", server.accessToken);

      const again = await manager.wait("github", signal());
      expect(again).toContain("is connected");
      expect(again).toContain("$GH_TOKEN");
    });
  });

  test("切断すると、保存したトークンも消える", async () => {
    await withConnectors(async ({ manager, dir, server }) => {
      await manager.setToken("github", server.accessToken);

      const tokenPath = join(dir, "data", "connectors", "github.json");
      expect(existsSync(tokenPath)).toBe(true);

      manager.disconnect("github");

      expect(existsSync(tokenPath)).toBe(false);
      expect(manager.env()).toEqual({});
      expect(manager.view().providers[0]?.account).toBeNull();
    });
  });

  test("保存されているトークンが壊れていたら、理由を出す", async () => {
    await withConnectors(async ({ manager, dir }) => {
      const tokenDir = join(dir, "data", "connectors");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(join(tokenDir, "github.json"), "{ not json", "utf8");

      expect(manager.view().providers[0]?.detail).not.toBeNull();
      expect(manager.env()).toEqual({});
      expect(await rejectionOf(manager.wait("github", signal()))).toMatch(/could not be read/);
    });
  });

  test("知らないコネクタ id は失敗する", async () => {
    await withConnectors(async ({ manager }) => {
      expect(() => manager.provider("unknown")).toThrow(ConnectorNotFound);
    });
  });
});

type ProgramContext = {
  manager: ConnectorsManager;
  dir: string;
  fake: FakeProgramRuntime;
};

const AGENT_DIR = posix.join(WORKDIR_IN_CONTAINER, ".pi", "agent");
const AUTH_PATH = posix.join(AGENT_DIR, "auth.json");
const SETTINGS_PATH = posix.join(AGENT_DIR, "settings.json");
const API_KEY = "sk-test-key";

type FakeProgramRuntime = {
  runtime: PiRuntime;
  files: Map<string, string>;
  writes: { path: string; text: string }[];
  scripts: string[];
};

function ok(stdout = ""): ConnectorScriptResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function successCheck(): ConnectorScriptResult {
  return ok(
    `${JSON.stringify({
      type: "message_end",
      message: { stopReason: "stop", content: [{ type: "text", text: "OK" }] },
    })}\n`,
  );
}

/** コンピュータの読み書きと実行を、メモリ上で真似る。 */
function fakePiRuntime(options: { check?: ConnectorScriptResult; chmod?: ConnectorScriptResult } = {}): FakeProgramRuntime {
  const files = new Map<string, string>();
  const writes: { path: string; text: string }[] = [];
  const scripts: string[] = [];

  const runtime: PiRuntime = {
    async run(script) {
      scripts.push(script);
      if (script === "pi --version") return ok("1.3.0\n");
      if (script.startsWith("chmod ")) return options.chmod ?? ok();
      return options.check ?? successCheck();
    },
    async readText(path) {
      return files.get(path) ?? null;
    },
    async writeText(path, text) {
      writes.push({ path, text });
      files.set(path, text);
    },
  };

  return { runtime, files, writes, scripts };
}

/** program コネクタと、コンピュータの偽の読み書きを用意する。 */
async function withProgramConnectors(
  run: (context: ProgramContext) => Promise<void>,
  options: { check?: ConnectorScriptResult; chmod?: ConnectorScriptResult } = {},
): Promise<void> {
  await withTempDir("terasuma-connectors-", async (dir) => {
    const fake = fakePiRuntime(options);
    const manager = createConnectors({
      dataDir: join(dir, "data"),
      providers: [fakeProgramProvider()],
      runtime: fake.runtime,
    });

    try {
      await run({ manager, dir, fake });
    } finally {
      manager.close();
    }
  });
}

describe("program コネクタ", () => {
  test("未接続なら、トークンも状態も無い", async () => {
    await withProgramConnectors(async ({ manager }) => {
      expect(manager.connected("pi")).toBe(false);
      expect(manager.view().providers[0]).toMatchObject({
        kind: "program",
        token: null,
        connected: false,
        status: null,
      });
      expect(manager.view().providers[0]?.setup?.provider.value).toBeNull();
      expect(manager.view().providers[0]?.setup?.model.value).toBeNull();
    });
  });

  test("未接続なら、wait は設定されるまで待つ（connect で解ける）", async () => {
    await withProgramConnectors(async ({ manager }) => {
      const waiting = manager.wait("pi", signal());

      await manager.connect("pi", { provider: "anthropic", apiKey: API_KEY });

      const text = await waiting;
      expect(text).toContain("pi-coding-agent is ready in the computer (pi 1.3.0 (anthropic/claude-sonnet-4-5))");
      expect(text).toContain("Load the pi-coding skill");
    });
  });

  test("キーを渡すと設定を書き、結果を 0600 で保存する", async () => {
    await withProgramConnectors(async ({ manager, dir, fake }) => {
      const view = await manager.connect("pi", { provider: "anthropic", apiKey: API_KEY });

      expect(view.providers[0]).toMatchObject({
        connected: true,
        status: "pi 1.3.0 (anthropic/claude-sonnet-4-5)",
      });
      expect(view.providers[0]?.setup?.provider.value).toBe("anthropic");
      expect(view.providers[0]?.setup?.model.value).toBe("claude-sonnet-4-5");

      expect(JSON.parse(fake.files.get(AUTH_PATH) ?? "{}")).toEqual({
        anthropic: { type: "api_key", key: API_KEY },
      });
      expect(JSON.parse(fake.files.get(SETTINGS_PATH) ?? "{}")).toMatchObject({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
      });

      const path = join(dir, "data", "connectors", "pi.json");
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  test("キー無しの connect は確かめるだけで、失敗すれば記録を残さない", async () => {
    await withProgramConnectors(
      async ({ manager, dir, fake }) => {
        const reason = await rejectionOf(manager.connect("pi"));

        expect(reason).toBe("401 unauthorized");
        expect(fake.writes).toEqual([]);
        expect(manager.connected("pi")).toBe(false);
        expect(existsSync(join(dir, "data", "connectors", "pi.json"))).toBe(false);
      },
      {
        check: ok(
          `${JSON.stringify({
            type: "message_end",
            message: { stopReason: "error", errorMessage: "401 unauthorized" },
          })}\n`,
        ),
      },
    );
  });

  test("知らない provider は失敗し、設定も記録も書かない", async () => {
    await withProgramConnectors(async ({ manager, dir, fake }) => {
      expect(await rejectionOf(manager.connect("pi", { provider: "unknown", apiKey: API_KEY }))).toBe(
        'pi-coding-agent: unknown provider "unknown".',
      );

      expect(fake.writes).toEqual([]);
      expect(existsSync(join(dir, "data", "connectors", "pi.json"))).toBe(false);
    });
  });

  test("切断すると、確かめた記録も消える", async () => {
    await withProgramConnectors(async ({ manager, dir }) => {
      await manager.connect("pi", { provider: "anthropic", apiKey: API_KEY });
      const path = join(dir, "data", "connectors", "pi.json");
      expect(existsSync(path)).toBe(true);

      manager.disconnect("pi");

      expect(existsSync(path)).toBe(false);
      expect(manager.connected("pi")).toBe(false);
    });
  });

  test("program コネクタにトークンは保存できない", async () => {
    await withProgramConnectors(async ({ manager }) => {
      expect(await rejectionOf(manager.setToken("pi", "token"))).toMatch(/does not use a token/);
    });
  });

  test("program コネクタの値は、環境変数に載らない", async () => {
    await withProgramConnectors(async ({ manager }) => {
      await manager.connect("pi", { provider: "anthropic", apiKey: API_KEY });
      expect(manager.env()).toEqual({});
      expect(manager.token("pi")).toBeNull();
    });
  });
});

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { createConnections, type ConnectionsManager } from "../src/server/connections/manager";
import type { ConnectionProvider } from "../src/server/connections/providers";
import { createConnectionTools } from "../src/server/connections/tools";
import { createSettingsStore, type SettingsStore } from "../src/server/data/settings";
import { withTempDir } from "./harness";
import {
  fakeBotProvider,
  fakeProvider,
  startFakeDeviceFlowServer,
  type FakeDeviceFlowServer,
} from "./fixtures/device-flow-server";

/**
 * アプリの接続ツール（computer_connect_app / app_request）。
 * モデルを介さずにツールをそのまま呼び、戻り値と失敗の文を確かめる。
 */

type Context = {
  tools: ToolSet;
  manager: ConnectionsManager;
  settings: SettingsStore;
  dir: string;
  server: FakeDeviceFlowServer;
};

async function withTools(
  run: (context: Context) => Promise<void>,
  extraProviders: (server: FakeDeviceFlowServer) => ConnectionProvider[] = () => [],
): Promise<void> {
  const server = startFakeDeviceFlowServer();
  try {
    await withTempDir("terasuma-connection-tools-", async (dir) => {
      const settings = createSettingsStore(join(dir, "config.json"));
      settings.setConnectionClientId("github", "client-1");

      const manager = createConnections({
        settings,
        dataDir: join(dir, "data"),
        providers: [fakeProvider(server), ...extraProviders(server)],
      });
      const tools = createConnectionTools({ connections: manager });

      try {
        await run({ tools, manager, settings, dir, server });
      } finally {
        manager.close();
      }
    });
  } finally {
    await server.server.stop(true);
  }
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function callTool(
  tools: ToolSet,
  name: string,
  input: unknown,
  context: { abortSignal?: AbortSignal } = {},
): Promise<unknown> {
  const entry = tools[name];
  if (entry?.execute === undefined) throw new Error(`${name} が無い`);
  return entry.execute(input as never, context as never);
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

/** 偽の認可サーバーを承認して、接続を終わらせる。 */
async function connect(manager: ConnectionsManager, server: FakeDeviceFlowServer): Promise<void> {
  server.approve();
  await manager.wait("github", new AbortController().signal);
}

describe("アプリの接続ツール", () => {
  test("ツール名は computer_connect_app と app_request", async () => {
    await withTools(async ({ tools }) => {
      expect(Object.keys(tools)).toEqual(["computer_connect_app", "app_request"]);
    });
  });

  test("接続していなければ、app_request は接続を促す", async () => {
    await withTools(async ({ tools }) => {
      const error = await rejectionOf(
        callTool(tools, "app_request", { provider: "github", method: "GET", path: "/user" }),
      );
      expect(error).toMatch(/not connected/);
    });
  });

  test("computer_connect_app は承認されると接続済みの文を返し、以後は待たない", async () => {
    await withTools(async ({ tools, server }) => {
      const context = { abortSignal: new AbortController().signal };
      const waiting = callTool(
        tools,
        "computer_connect_app",
        { provider: "github", reason: "issue を読むため" },
        context,
      );

      server.approve();
      expect(await waiting).toContain("@octocat");

      expect(
        await callTool(tools, "computer_connect_app", { provider: "github", reason: "もう一度" }, context),
      ).toContain("is connected");
      // 2 回目は認可を始め直さない。
      expect(server.deviceRequests).toHaveLength(1);
    });
  });

  test("接続済みなら、app_request が API を叩ける", async () => {
    await withTools(async ({ tools, manager, server }) => {
      await connect(manager, server);

      const result = await callTool(tools, "app_request", { provider: "github", method: "GET", path: "/user" });
      expect(result).toBe('HTTP 200\n{"login":"octocat"}');

      const repo = await callTool(tools, "app_request", {
        provider: "github",
        method: "GET",
        path: "/repos/octocat/hello",
      });
      expect(repo).toBe('HTTP 200\n{"full_name":"octocat/hello"}');
    });
  });

  test("app_request はエラーの応答も本文として返す", async () => {
    await withTools(async ({ tools, manager, server }) => {
      await connect(manager, server);

      const result = await callTool(tools, "app_request", { provider: "github", method: "GET", path: "/error" });
      expect(result).toBe('HTTP 500\n{"message":"boom"}');
    });
  });

  test("app_request は接続先の外へ出るパスを受け付けない", async () => {
    await withTools(async ({ tools, manager, server }) => {
      await connect(manager, server);

      expect(
        await rejectionOf(
          callTool(tools, "app_request", { provider: "github", method: "GET", path: "//example.test/user" }),
        ),
      ).toMatch(/single/);
      expect(
        await rejectionOf(
          callTool(tools, "app_request", { provider: "github", method: "GET", path: "https://example.test/user" }),
        ),
      ).toMatch(/single/);
    });
  });

  test("保存された認可が拒否されたら、接続し直すよう促す", async () => {
    await withTools(async ({ tools, manager, settings, dir, server }) => {
      await connect(manager, server);

      // 誤ったトークンが保存されている状態を作り、別のマネージャに読ませる。
      writeFileSync(
        join(dir, "data", "connections", "github.json"),
        JSON.stringify({ accessToken: "wrong", scope: null, account: null, obtainedAt: 0 }),
        "utf8",
      );
      const stale = createConnections({ settings, dataDir: join(dir, "data"), providers: [fakeProvider(server)] });
      const staleTools = createConnectionTools({ connections: stale });

      try {
        const error = await rejectionOf(
          callTool(staleTools, "app_request", { provider: "github", method: "GET", path: "/user" }),
        );
        expect(error).toMatch(/rejected the saved authorization/);
      } finally {
        stale.close();
      }

      // 元のツールは、まだ手元のトークンで動く。
      expect(await callTool(tools, "app_request", { provider: "github", method: "GET", path: "/user" })).toContain(
        "HTTP 200",
      );
    });
  });

  test("知らないアプリは、使える名前を添えて断る", async () => {
    await withTools(async ({ tools }) => {
      expect(
        await rejectionOf(
          callTool(
            tools,
            "computer_connect_app",
            { provider: "linear", reason: "issue を見るため" },
            { abortSignal: new AbortController().signal },
          ),
        ),
      ).toMatch(/Unknown app/);
      expect(
        await rejectionOf(callTool(tools, "app_request", { provider: "linear", method: "GET", path: "/user" })),
      ).toMatch(/Unknown app/);
    });
  });

  test("Client ID が無ければ、設定を開くよう促す", async () => {
    await withTools(async ({ tools, settings }) => {
      settings.setConnectionClientId("github", null);

      const error = await rejectionOf(
        callTool(
          tools,
          "computer_connect_app",
          { provider: "github", reason: "issue を読むため" },
          { abortSignal: new AbortController().signal },
        ),
      );
      expect(error).toMatch(/no Client ID is configured/);
    });
  });

  test("ターンが止まると、接続の待ちも終わる", async () => {
    await withTools(async ({ tools }) => {
      const controller = new AbortController();
      const waiting = callTool(
        tools,
        "computer_connect_app",
        { provider: "github", reason: "issue を読むため" },
        { abortSignal: controller.signal },
      );
      const rejected = rejectionOf(waiting);

      controller.abort();
      expect(await rejected).toMatch(/turn ended/);
    });
  });

  test("bot は保存したトークンを Bot ヘッダーで送り、メッセージを投稿できる", async () => {
    await withTools(
      async ({ tools, manager, server }) => {
        await manager.setToken("discord", server.botToken);

        const result = await callTool(tools, "app_request", {
          provider: "discord",
          method: "POST",
          path: "/channels/123/messages",
          body: { content: "hello" },
        });

        expect(result).toContain("HTTP 200");
        expect(result).toContain('"content":"hello"');
      },
      (server) => [fakeBotProvider(server)],
    );
  });

  test("bot はメッセージを読むこともできる", async () => {
    await withTools(
      async ({ tools, manager, server }) => {
        await manager.setToken("discord", server.botToken);

        const result = await callTool(tools, "app_request", {
          provider: "discord",
          method: "GET",
          path: "/channels/123/messages",
        });

        expect(result).toContain("HTTP 200");
        expect(result).toContain("hello");
      },
      (server) => [fakeBotProvider(server)],
    );
  });

  test("bot が未接続なら、設定画面での保存を促す", async () => {
    await withTools(
      async ({ tools }) => {
        const error = await rejectionOf(
          callTool(
            tools,
            "computer_connect_app",
            { provider: "discord", reason: "通知を送るため" },
            { abortSignal: new AbortController().signal },
          ),
        );
        expect(error).toMatch(/Settings > Connections/);
      },
      (server) => [fakeBotProvider(server)],
    );
  });

  test("知らないアプリの案内には、使える id が並ぶ", async () => {
    await withTools(
      async ({ tools }) => {
        const error = await rejectionOf(
          callTool(tools, "app_request", { provider: "linear", method: "GET", path: "/user" }),
        );
        expect(error).toContain("github");
        expect(error).toContain("discord");
      },
      (server) => [fakeBotProvider(server)],
    );
  });
});

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { createConnections, type ConnectionsManager } from "../src/server/connections/manager";
import { createConnectionTools } from "../src/server/connections/tools";
import { withTempDir } from "./harness";
import { fakeProvider, startFakeConnectionServer, type FakeConnectionServer } from "./fixtures/connection-server";

/**
 * アプリの接続ツール（computer_connect_app / app_request）。
 * モデルを介さずにツールをそのまま呼び、戻り値と失敗の文を確かめる。
 */

type Context = {
  tools: ToolSet;
  manager: ConnectionsManager;
  dir: string;
  server: FakeConnectionServer;
};

async function withTools(run: (context: Context) => Promise<void>): Promise<void> {
  const server = startFakeConnectionServer();
  try {
    await withTempDir("terasuma-connection-tools-", async (dir) => {
      const manager = createConnections({ dataDir: join(dir, "data"), providers: [fakeProvider(server)] });
      const tools = createConnectionTools({ connections: manager });

      try {
        await run({ tools, manager, dir, server });
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

/** 偽の API サーバーのトークンで、GitHub を接続済みにする。 */
async function connect(manager: ConnectionsManager, server: FakeConnectionServer): Promise<void> {
  await manager.setToken("github", server.accessToken);
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

  test("computer_connect_app はトークンが保存されるまで待ち、以後は待たない", async () => {
    await withTools(async ({ tools, manager, server }) => {
      const context = { abortSignal: new AbortController().signal };
      const waiting = callTool(
        tools,
        "computer_connect_app",
        { provider: "github", reason: "issue を読むため" },
        context,
      );

      await manager.setToken("github", server.accessToken);
      expect(await waiting).toContain(`@${server.account}`);

      expect(
        await callTool(tools, "computer_connect_app", { provider: "github", reason: "もう一度" }, context),
      ).toContain("is connected");
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

  test("保存されたトークンが拒否されたら、保存し直すよう促す", async () => {
    await withTools(async ({ tools, manager, dir, server }) => {
      await connect(manager, server);

      // 誤ったトークンが保存されている状態を作り、別のマネージャに読ませる。
      writeFileSync(
        join(dir, "data", "connections", "github.json"),
        JSON.stringify({ accessToken: "wrong", account: null, obtainedAt: 0 }),
        "utf8",
      );
      const stale = createConnections({ dataDir: join(dir, "data"), providers: [fakeProvider(server)] });
      const staleTools = createConnectionTools({ connections: stale });

      try {
        const error = await rejectionOf(
          callTool(staleTools, "app_request", { provider: "github", method: "GET", path: "/user" }),
        );
        expect(error).toMatch(/rejected the saved token/);
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

      const error = await rejectionOf(
        callTool(tools, "app_request", { provider: "linear", method: "GET", path: "/user" }),
      );
      expect(error).toMatch(/Unknown app/);
      expect(error).toContain("github");
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
});

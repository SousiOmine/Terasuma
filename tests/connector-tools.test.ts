import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { createConnectors, type ConnectorsManager } from "../src/server/connectors/manager";
import { createConnectorTools } from "../src/server/connectors/tools";
import { withTempDir } from "./harness";
import {
  fakeProgramProvider,
  fakeProvider,
  startFakeConnectorServer,
  type FakeConnectorServer,
} from "./fixtures/connector-server";

/**
 * コネクタのツール（app_connect_<id> / app_request）。
 * モデルを介さずにツールをそのまま呼び、戻り値と失敗の文を確かめる。
 */

type Context = {
  tools: ToolSet;
  manager: ConnectorsManager;
  dir: string;
  server: FakeConnectorServer;
};

async function withTools(run: (context: Context) => Promise<void>): Promise<void> {
  const server = startFakeConnectorServer();
  try {
    await withTempDir("terasuma-connector-tools-", async (dir) => {
      const manager = createConnectors({
        dataDir: join(dir, "data"),
        providers: [fakeProvider(server), { ...fakeProgramProvider(), name: "Test Program" }],
      });
      const tools = createConnectorTools({ connectors: manager });

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
async function connect(manager: ConnectorsManager, server: FakeConnectorServer): Promise<void> {
  await manager.setToken("github", server.accessToken);
}

describe("コネクタのツール", () => {
  test("ツール名はアプリごとの接続ツールと app_request", async () => {
    await withTools(async ({ tools }) => {
      expect(Object.keys(tools)).toEqual(["app_connect_github", "app_connect_pi", "app_request"]);
      // 旧来の 1 つの接続ツールは残っていない。
      expect(Object.keys(tools)).not.toContain(["computer", "connect", "app"].join("_"));
    });
  });

  test("接続ツールの説明は、そのアプリの needs と usage を含む", async () => {
    await withTools(async ({ tools, manager }) => {
      for (const id of ["github", "pi"]) {
        const provider = manager.provider(id);
        const description = tools[`app_connect_${id}`]?.description ?? "";

        expect(description).toContain(`Connect ${provider.name}.`);
        expect(description).toContain(provider.needs);
        expect(description).toContain(provider.usage);
      }
    });
  });

  test("app_request の説明は特定のアプリに依存しない", async () => {
    await withTools(async ({ tools }) => {
      const description = tools["app_request"]?.description ?? "";

      expect(description).not.toContain("GitHub");
      expect(description).not.toMatch(/\bpi\b/);
      expect(description).toContain("API");
      expect(description).toContain("token");
    });
  });

  test("API を持たない program コネクタには、app_request を使わないよう伝える", async () => {
    await withTools(async ({ tools }) => {
      const error = await rejectionOf(callTool(tools, "app_request", { provider: "pi", method: "GET", path: "/user" }));

      expect(error).toContain("has no API");
      expect(error).not.toContain("pi-coding");
    });
  });

  test("接続していなければ、app_request はそのアプリの接続ツールを案内する", async () => {
    await withTools(async ({ tools }) => {
      const error = await rejectionOf(
        callTool(tools, "app_request", { provider: "github", method: "GET", path: "/user" }),
      );
      expect(error).toMatch(/not connected/);
      expect(error).toContain("app_connect_github");
    });
  });

  test("接続ツールは設定が保存されるまで待ち、以後は待たない", async () => {
    await withTools(async ({ tools, manager, server }) => {
      const context = { abortSignal: new AbortController().signal };
      const waiting = callTool(tools, "app_connect_github", { reason: "issue を読むため" }, context);

      await manager.setToken("github", server.accessToken);
      expect(await waiting).toContain(`@${server.account}`);

      expect(await callTool(tools, "app_connect_github", { reason: "もう一度" }, context)).toContain("is connected");
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
        join(dir, "data", "connectors", "github.json"),
        JSON.stringify({ accessToken: "wrong", account: null, obtainedAt: 0 }),
        "utf8",
      );
      const stale = createConnectors({ dataDir: join(dir, "data"), providers: [fakeProvider(server)] });
      const staleTools = createConnectorTools({ connectors: stale });

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

  test("app_request の知らないアプリは、使える名前を添えて断る", async () => {
    await withTools(async ({ tools }) => {
      const error = await rejectionOf(
        callTool(tools, "app_request", { provider: "linear", method: "GET", path: "/user" }),
      );
      expect(error).toMatch(/Unknown app/);
      expect(error).toContain("github");
    });
  });

  test("ターンが止まると、コネクタの待ちも終わる", async () => {
    await withTools(async ({ tools }) => {
      const controller = new AbortController();
      const waiting = callTool(
        tools,
        "app_connect_github",
        { reason: "issue を読むため" },
        { abortSignal: controller.signal },
      );
      const rejected = rejectionOf(waiting);

      controller.abort();
      expect(await rejected).toMatch(/turn ended/);
    });
  });
});

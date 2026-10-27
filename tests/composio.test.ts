import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { COMPOSIO_EXECUTE_TOOL_NAME, COMPOSIO_SEARCH_TOOL_NAME } from "../src/shared/tools";
import { COMPOSIO_USER_ID } from "../src/server/connectors/composio";
import { createConnectors, type ConnectorsManager } from "../src/server/connectors/manager";
import { createConnectorTools } from "../src/server/connectors/tools";
import { withTempDir } from "./harness";
import { fakeComposioProvider, startFakeComposioServer, type FakeComposioServer } from "./fixtures/composio-server";

/**
 * Composio のコネクタ。
 * 検索と実行の 2 つだけを持ち、キーは x-api-key で送る。
 * キーはコンテナへ渡さず、ツールの戻り値にも現れない。
 */

type Context = {
  tools: ToolSet;
  manager: ConnectorsManager;
  server: FakeComposioServer;
  dir: string;
};

async function withComposio(run: (context: Context) => Promise<void>): Promise<void> {
  const server = startFakeComposioServer();
  try {
    await withTempDir("terasuma-composio-", async (dir) => {
      const manager = createConnectors({ dataDir: join(dir, "data"), providers: [fakeComposioProvider(server)] });
      const tools = createConnectorTools({ connectors: manager });

      try {
        await run({ tools, manager, server, dir });
      } finally {
        manager.close();
      }
    });
  } finally {
    await server.server.stop(true);
  }
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function callTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const entry = tools[name];
  if (entry?.execute === undefined) throw new Error(`${name} が無い`);
  return entry.execute(input as never, { abortSignal: new AbortController().signal } as never);
}

/** 失敗するまで待って、理由を 1 文で返す。 */
function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "(resolved)",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("Composio のコネクタ", () => {
  test("ツールは検索と実行の 2 つで、接続ツールと app_request も並ぶ", async () => {
    await withComposio(async ({ tools }) => {
      expect(Object.keys(tools).sort()).toEqual(
        [COMPOSIO_EXECUTE_TOOL_NAME, COMPOSIO_SEARCH_TOOL_NAME, "app_connect_composio", "app_request"].sort(),
      );
    });
  });

  test("キーを保存すると、アカウント名なしで接続済みになり、環境変数には載らない", async () => {
    await withComposio(async ({ manager, server }) => {
      const view = await manager.setToken("composio", server.apiKey);
      const provider = view.providers[0];

      expect(provider).toMatchObject({ id: "composio", connected: true, account: null, detail: null });
      // Composio のキーはコンテナへ渡さない。
      expect(manager.env()).toEqual({});
      expect(provider?.env).toEqual([]);
    });
  });

  test("受け付けられないキーは保存しない", async () => {
    await withComposio(async ({ manager }) => {
      expect(await rejectionOf(manager.setToken("composio", "wrong"))).toBe(
        "Composio did not accept the token (HTTP 401)",
      );
      expect(manager.connected("composio")).toBe(false);
    });
  });

  test("接続の文に環境変数の案内を出さない", async () => {
    await withComposio(async ({ manager, server }) => {
      await manager.setToken("composio", server.apiKey);

      const text = await manager.wait("composio", new AbortController().signal);
      expect(text).toContain("Composio is connected.");
      expect(text).toContain("app_composio_search");
      expect(text).not.toContain("$");
    });
  });

  test("検索は x-api-key で叩き、slug と引数を返す", async () => {
    await withComposio(async ({ tools, manager, server }) => {
      await manager.setToken("composio", server.apiKey);

      const result = (await callTool(tools, COMPOSIO_SEARCH_TOOL_NAME, { query: "create an issue" })) as string;

      expect(result).toContain("Found 1 tool(s)");
      expect(result).toContain("GITHUB_CREATE_ISSUE (github)");
      expect(result).toContain("owner (string, required)");
      expect(result).toContain("body (string, optional)");
      expect(result).toContain("Run one with app_composio_execute");
      expect(result).not.toContain(server.apiKey);

      const request = server.requests[0];
      expect(request?.method).toBe("GET");
      expect(request?.path).toBe("/api/v3.1/tools");
    });
  });

  test("実行は user_id と引数を送り、結果を返す", async () => {
    await withComposio(async ({ tools, manager, server }) => {
      await manager.setToken("composio", server.apiKey);

      const result = (await callTool(tools, COMPOSIO_EXECUTE_TOOL_NAME, {
        toolSlug: "GITHUB_CREATE_ISSUE",
        args: { owner: "octocat", repo: "hello", title: "boom" },
      })) as string;

      expect(result).toContain("GITHUB_CREATE_ISSUE ran.");
      expect(result).toContain('"number": 7');
      expect(result).not.toContain(server.apiKey);

      const request = server.requests[0];
      expect(request?.path).toBe("/api/v3.1/tools/execute/GITHUB_CREATE_ISSUE");
      expect(JSON.parse(request?.body ?? "{}")).toEqual({
        user_id: COMPOSIO_USER_ID,
        arguments: { owner: "octocat", repo: "hello", title: "boom" },
        version: "latest",
      });
    });
  });

  test("実行に失敗したら、理由を付けて失敗にする", async () => {
    await withComposio(async ({ tools, manager, server }) => {
      await manager.setToken("composio", server.apiKey);

      const error = await rejectionOf(callTool(tools, COMPOSIO_EXECUTE_TOOL_NAME, { toolSlug: "GITHUB_BAD" }));
      expect(error).toContain("GITHUB_BAD");
      expect(error).toContain("Repository not found");
    });
  });

  test("未接続なら、接続ツールを案内して失敗する", async () => {
    await withComposio(async ({ tools }) => {
      const search = await rejectionOf(callTool(tools, COMPOSIO_SEARCH_TOOL_NAME, { query: "mail" }));
      expect(search).toContain("not connected");
      expect(search).toContain("app_connect_composio");

      const execute = await rejectionOf(
        callTool(tools, COMPOSIO_EXECUTE_TOOL_NAME, { toolSlug: "GITHUB_CREATE_ISSUE" }),
      );
      expect(execute).toContain("app_connect_composio");
    });
  });

  test("保存されたキーが拒否されたら、保存し直すよう促す", async () => {
    await withComposio(async ({ tools, manager, server, dir }) => {
      await manager.setToken("composio", server.apiKey);

      // 誤ったキーが保存されている状態を作り、別のマネージャに読ませる。
      writeFileSync(
        join(dir, "data", "connectors", "composio.json"),
        JSON.stringify({ accessToken: "ak_stale", account: null, obtainedAt: 0 }),
        "utf8",
      );
      const stale = createConnectors({ dataDir: join(dir, "data"), providers: [fakeComposioProvider(server)] });
      const staleTools = createConnectorTools({ connectors: stale });

      try {
        const error = await rejectionOf(callTool(staleTools, COMPOSIO_SEARCH_TOOL_NAME, { query: "mail" }));
        expect(error).toContain("rejected the saved API key");
        expect(error).toContain("app_connect_composio");
      } finally {
        stale.close();
      }

      // 元のツールは、まだ手元のキーで動く。
      expect(await callTool(tools, COMPOSIO_SEARCH_TOOL_NAME, { query: "create an issue" })).toContain(
        "GITHUB_CREATE_ISSUE",
      );
    });
  });

  test("app_request は x-api-key で Composio の API を叩く", async () => {
    await withComposio(async ({ tools, manager, server }) => {
      await manager.setToken("composio", server.apiKey);

      const result = (await callTool(tools, "app_request", {
        provider: "composio",
        method: "GET",
        path: "/tools/GITHUB_CREATE_ISSUE",
      })) as string;

      expect(result).toContain("HTTP 200");
      expect(server.requests[0]?.path).toBe("/api/v3.1/tools/GITHUB_CREATE_ISSUE");
    });
  });
});

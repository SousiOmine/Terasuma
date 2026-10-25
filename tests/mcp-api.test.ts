import { describe, expect, test } from "bun:test";
import type { FileSettings, McpServerSettings } from "../src/server/data/settings";
import type { AuthorizationCallback, McpManager } from "../src/server/mcp/manager";
import type { McpServerStatusView, McpServersView, McpTestView } from "../src/shared/api/settings";
import { withServer } from "./harness";

const UNKNOWN: McpServerStatusView = { state: "unknown", tools: [], detail: null };

/** 接続を持たない manager。API が設定と状態をどう扱うかだけを確かめる。 */
function createManagerStub() {
  const statuses = new Map<string, McpServerStatusView>();
  const calls = {
    check: [] as string[],
    authorize: [] as string[],
    cancelled: [] as string[],
    forgotten: [] as string[],
    completed: [] as AuthorizationCallback[],
    tested: [] as { id: string; server: McpServerSettings }[],
  };
  let completionFailure: string | null = null;
  let testResult: McpTestView = { ...UNKNOWN, authorizationUrl: null };

  const statusOf = (id: string): McpServerStatusView => statuses.get(id) ?? UNKNOWN;

  const manager: McpManager = {
    status: statusOf,
    check: async (id) => {
      calls.check.push(id);
      return statusOf(id);
    },
    test: async (id, server) => {
      calls.tested.push({ id, server });
      return testResult;
    },
    toolset: async () => ({}),
    authorize: async (id) => {
      calls.authorize.push(id);
      return { url: `https://auth.example.test/${id}` };
    },
    cancelAuthorization: (id) => {
      calls.cancelled.push(id);
    },
    cancelTest: (id) => {
      calls.cancelled.push(id);
    },
    forget: async (id) => {
      calls.forgotten.push(id);
      statuses.delete(id);
    },
    completeAuthorization: async (_state, callback) => {
      calls.completed.push(callback);
      if (completionFailure !== null) throw new Error(completionFailure);
      return { serverId: "remote" };
    },
    close: async () => undefined,
  };

  return {
    manager,
    statuses,
    calls,
    failCompletion(message: string | null) {
      completionFailure = message;
    },
    returnTestResult(result: McpTestView) {
      testResult = result;
    },
  };
}

type Harness = {
  request(path: string, init?: RequestInit): Promise<Response>;
  servers(): Promise<McpServersView>;
  file(): FileSettings;
};

/** 一時ディレクトリに本物の設定ファイルを置いて、MCP の API を HTTP 越しに確かめる。 */
async function withMcpServer<T>(
  initial: FileSettings,
  run: (harness: Harness, stub: ReturnType<typeof createManagerStub>) => Promise<T>,
): Promise<T> {
  const stub = createManagerStub();

  return withServer(
    ({ request, file }) =>
      run(
        {
          request,
          async servers() {
            const response = await request("/api/mcp/servers");
            expect(response.status).toBe(200);
            return (await response.json()) as McpServersView;
          },
          file,
        },
        stub,
      ),
    { settings: initial, mcp: stub.manager },
  );
}

const LOCAL: McpServerSettings = {
  type: "stdio",
  command: "bunx",
  args: ["-y", "server-filesystem"],
  env: { TOKEN: "abc" },
};

describe("MCP サーバーの API", () => {
  test("一覧は設定と、いま分かっている接続状態を返す", async () => {
    await withMcpServer({ mcpServers: { local: LOCAL } }, async (harness, stub) => {
      stub.statuses.set("local", { state: "connected", tools: ["echo"], detail: null });

      const view = await harness.servers();
      expect(view.servers).toEqual([
        {
          id: "local",
          type: "stdio",
          command: "bunx",
          args: ["-y", "server-filesystem"],
          env: { TOKEN: "abc" },
          url: null,
          status: { state: "connected", tools: ["echo"], detail: null },
        },
      ]);
    });
  });

  test("サーバーを追加すると設定ファイルに書かれ、一覧が返る", async () => {
    await withMcpServer({}, async (harness) => {
      const response = await harness.request("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "local", type: "stdio", command: " bunx ", args: ["-y", "x"], env: {} }),
      });

      expect(response.status).toBe(200);
      const view = (await response.json()) as McpServersView;
      expect(view.servers.map((server) => server.id)).toEqual(["local"]);
      expect(view.servers[0]?.status.state).toBe("unknown");
      expect(harness.file().mcpServers).toEqual({ local: { type: "stdio", command: "bunx", args: ["-y", "x"] } });
    });
  });

  test("同じ名前の追加は 409、壊れた入力は 400 で弾く", async () => {
    await withMcpServer({ mcpServers: { local: LOCAL } }, async (harness) => {
      const send = (body: unknown) =>
        harness.request("/api/mcp/servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      expect((await send({ id: "local", type: "stdio", command: "bunx" })).status).toBe(409);
      expect((await send({ id: "Bad Name", type: "stdio", command: "bunx" })).status).toBe(400);

      const badUrl = await send({ id: "remote", type: "http", url: "file:///tmp/x" });
      expect(badUrl.status).toBe(400);
      expect(((await badUrl.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("設定を変えると保存され、URL と id の食い違いは 400", async () => {
    await withMcpServer(
      { mcpServers: { remote: { type: "http", url: "https://old.example.test/mcp" } } },
      async (harness) => {
        const patch = (id: string, body: unknown) =>
          harness.request(`/api/mcp/servers/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

        const updated = await patch("remote", { id: "remote", type: "http", url: "https://new.example.test/mcp" });
        expect(updated.status).toBe(200);
        expect(harness.file().mcpServers).toEqual({
          remote: { type: "http", url: "https://new.example.test/mcp" },
        });

        expect((await patch("remote", { id: "other", type: "http", url: "https://new.example.test/mcp" })).status).toBe(
          400,
        );
        expect(
          (await patch("missing", { id: "missing", type: "http", url: "https://x.example.test/mcp" })).status,
        ).toBe(404);
      },
    );
  });

  test("削除すると設定から消え、接続とツールもその場で片付き、一覧が返る", async () => {
    await withMcpServer({ mcpServers: { local: LOCAL } }, async (harness, stub) => {
      stub.statuses.set("local", { state: "connected", tools: ["echo"], detail: null });

      const removed = await harness.request("/api/mcp/servers/local", { method: "DELETE" });

      expect(removed.status).toBe(200);
      expect(((await removed.json()) as McpServersView).servers).toEqual([]);
      expect(harness.file().mcpServers).toEqual({});
      expect(stub.calls.forgotten).toEqual(["local"]);
      expect((await harness.request("/api/mcp/servers/local", { method: "DELETE" })).status).toBe(404);
    });
  });

  test("接続の確認は manager に任せ、結果をそのまま返す", async () => {
    await withMcpServer({ mcpServers: { local: LOCAL } }, async (harness, stub) => {
      stub.statuses.set("local", { state: "failed", tools: [], detail: "繋がりません" });

      const response = await harness.request("/api/mcp/servers/local/check", { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "failed", tools: [], detail: "繋がりません" });
      expect(stub.calls.check).toEqual(["local"]);

      expect((await harness.request("/api/mcp/servers/missing/check", { method: "POST" })).status).toBe(404);
    });
  });

  test("保存前の確認は、入力を検証して manager に渡し、結果をそのまま返す", async () => {
    await withMcpServer({}, async (harness, stub) => {
      stub.returnTestResult({ state: "connected", tools: ["echo", "fail"], detail: null, authorizationUrl: null });

      const response = await harness.request("/api/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: " remote ", type: "http", url: " https://mcp.example.test/mcp/ " }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        state: "connected",
        tools: ["echo", "fail"],
        detail: null,
        authorizationUrl: null,
      });
      expect(stub.calls.tested).toEqual([
        { id: "remote", server: { type: "http", url: "https://mcp.example.test/mcp" } },
      ]);
      // 確かめるだけなので、設定ファイルには何も書かない。
      expect(harness.file().mcpServers).toBeUndefined();
    });
  });

  test("保存前の確認は、認可が要る場合の URL を返し、壊れた入力は 400 で弾く", async () => {
    await withMcpServer({}, async (harness, stub) => {
      stub.returnTestResult({
        state: "authorization_required",
        tools: [],
        detail: null,
        authorizationUrl: "https://auth.example.test/authorize",
      });

      const send = (body: unknown) =>
        harness.request("/api/mcp/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const waiting = await send({ id: "remote", type: "http", url: "https://mcp.example.test/mcp" });
      expect(waiting.status).toBe(200);
      expect(await waiting.json()).toEqual({
        state: "authorization_required",
        tools: [],
        detail: null,
        authorizationUrl: "https://auth.example.test/authorize",
      });

      expect((await send({ id: "Bad Name", type: "http", url: "https://mcp.example.test/mcp" })).status).toBe(400);
      expect((await send({ id: "remote", type: "http", url: "file:///tmp/x" })).status).toBe(400);
      expect((await send({ id: "remote", type: "stdio", url: "https://mcp.example.test/mcp" })).status).toBe(400);
    });
  });

  test("保存前の確認で待っている認可も取り消せる", async () => {
    await withMcpServer({}, async (harness, stub) => {
      const response = await harness.request("/api/mcp/test/remote", { method: "DELETE" });

      expect(response.status).toBe(204);
      expect(stub.calls.cancelled).toEqual(["remote"]);
    });
  });

  test("認可は URL を返し、取り消しもできる", async () => {
    await withMcpServer(
      { mcpServers: { remote: { type: "http", url: "https://mcp.example.test/mcp" } } },
      async (harness, stub) => {
        const started = await harness.request("/api/mcp/servers/remote/authorize", { method: "POST" });
        expect(started.status).toBe(200);
        expect(await started.json()).toEqual({ url: "https://auth.example.test/remote" });
        expect(stub.calls.authorize).toEqual(["remote"]);

        const cancelled = await harness.request("/api/mcp/servers/remote/authorize", { method: "DELETE" });
        expect(cancelled.status).toBe(200);
        expect(((await cancelled.json()) as McpServersView).servers.map((server) => server.id)).toEqual(["remote"]);
        expect(stub.calls.cancelled).toEqual(["remote"]);
      },
    );
  });

  test("認可のコールバックは、成否をページで返す", async () => {
    await withMcpServer(
      { mcpServers: { remote: { type: "http", url: "https://mcp.example.test/mcp" } } },
      async (harness, stub) => {
        const ok = await harness.request("/api/mcp/oauth/callback?code=abc&state=terasuma.remote.1");
        expect(ok.status).toBe(200);
        expect(ok.headers.get("Content-Type")).toContain("text/html");
        expect(await ok.text()).toContain("認可が完了しました");
        expect(stub.calls.completed).toEqual([{ code: "abc", iss: null, error: null }]);

        stub.failCompletion("コードを交換できませんでした");
        const failed = await harness.request("/api/mcp/oauth/callback?code=abc&state=terasuma.remote.1");
        expect(failed.status).toBe(400);
        expect(await failed.text()).toContain("コードを交換できませんでした");

        const missingState = await harness.request("/api/mcp/oauth/callback?code=abc");
        expect(missingState.status).toBe(400);
      },
    );
  });
});

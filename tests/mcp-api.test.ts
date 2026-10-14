import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, readSettingsFile, type FileSettings, type McpServerSettings } from "../src/config";
import { createMockEngine } from "../src/server/engine";
import type { AuthorizationCallback, McpManager } from "../src/server/mcp";
import { startServer } from "../src/server/server";
import { createSettingsStore, type SettingsStore } from "../src/server/settings";
import { createStore } from "../src/server/store";
import type { McpServerStatusView, McpServersView } from "../src/shared/types";

const UNKNOWN: McpServerStatusView = { state: "unknown", tools: [], detail: null };

/** 接続を持たない manager。API が設定と状態をどう扱うかだけを確かめる。 */
function createManagerStub() {
  const statuses = new Map<string, McpServerStatusView>();
  const calls = { check: [] as string[], authorize: [] as string[], cancelled: [] as string[], completed: [] as AuthorizationCallback[] };
  let completionFailure: string | null = null;

  const statusOf = (id: string): McpServerStatusView => statuses.get(id) ?? UNKNOWN;

  const manager: McpManager = {
    status: statusOf,
    check: async (id) => {
      calls.check.push(id);
      return statusOf(id);
    },
    toolset: async () => ({}),
    authorize: async (id) => {
      calls.authorize.push(id);
      return { url: `https://auth.example.test/${id}` };
    },
    cancelAuthorization: (id) => {
      calls.cancelled.push(id);
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
  const dir = mkdtempSync(join(tmpdir(), "terasuma-mcp-api-"));
  const path = join(dir, CONFIG_FILE_NAME);
  writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

  const settings: SettingsStore = createSettingsStore(path);
  const stub = createManagerStub();
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
    mcp: stub.manager,
  });

  const request = (requestPath: string, init?: RequestInit) =>
    fetch(new URL(requestPath, server.url), init);

  try {
    return await run(
      {
        request,
        async servers() {
          const response = await request("/api/mcp/servers");
          expect(response.status).toBe(200);
          return (await response.json()) as McpServersView;
        },
        file: () => readSettingsFile(path),
      },
      stub,
    );
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
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
          oauth: false,
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
        body: JSON.stringify({ id: "local", type: "stdio", command: " bunx ", args: ["-y", "x"], env: {}, oauth: false }),
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
    await withMcpServer({ mcpServers: { remote: { type: "http", url: "https://old.example.test/mcp" } } }, async (harness) => {
      const patch = (id: string, body: unknown) =>
        harness.request(`/api/mcp/servers/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const updated = await patch("remote", { id: "remote", type: "http", url: "https://new.example.test/mcp", oauth: true });
      expect(updated.status).toBe(200);
      expect(harness.file().mcpServers).toEqual({
        remote: { type: "http", url: "https://new.example.test/mcp", oauth: true },
      });

      expect((await patch("remote", { id: "other", type: "http", url: "https://new.example.test/mcp" })).status).toBe(400);
      expect((await patch("missing", { id: "missing", type: "http", url: "https://x.example.test/mcp" })).status).toBe(404);
    });
  });

  test("削除すると設定から消え、一覧が返る", async () => {
    await withMcpServer({ mcpServers: { local: LOCAL } }, async (harness) => {
      const removed = await harness.request("/api/mcp/servers/local", { method: "DELETE" });

      expect(removed.status).toBe(200);
      expect(((await removed.json()) as McpServersView).servers).toEqual([]);
      expect(harness.file().mcpServers).toEqual({});
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

  test("認可は URL を返し、取り消しもできる", async () => {
    await withMcpServer({ mcpServers: { remote: { type: "http", url: "https://mcp.example.test/mcp", oauth: true } } }, async (harness, stub) => {
      const started = await harness.request("/api/mcp/servers/remote/authorize", { method: "POST" });
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ url: "https://auth.example.test/remote" });
      expect(stub.calls.authorize).toEqual(["remote"]);

      const cancelled = await harness.request("/api/mcp/servers/remote/authorize", { method: "DELETE" });
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as McpServersView).servers.map((server) => server.id)).toEqual(["remote"]);
      expect(stub.calls.cancelled).toEqual(["remote"]);
    });
  });

  test("認可のコールバックは、成否をページで返す", async () => {
    await withMcpServer({ mcpServers: { remote: { type: "http", url: "https://mcp.example.test/mcp", oauth: true } } }, async (harness, stub) => {
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
    });
  });
});

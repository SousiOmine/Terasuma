import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CONFIG_FILE_NAME, type McpServersSettings } from "../src/config";
import { McpServerNotFound, createMcpManager, type McpManager } from "../src/server/mcp";
import { createSettingsStore } from "../src/server/settings";

/** コールバックの URL。認可を使わないテストでは開かれない。 */
const CALLBACK_URL = "http://127.0.0.1:9/api/mcp/oauth/callback";

/** テスト用のツール。stdio と http で同じものを出す。 */
function registerTestTools(server: McpServer, serverName: string): void {
  server.registerTool(
    "echo",
    { description: `${serverName} の echo`, inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );

  server.registerTool(
    "fail",
    { description: `${serverName} の fail`, inputSchema: { reason: z.string() } },
    ({ reason }) => ({ content: [{ type: "text", text: `失敗: ${reason}` }], isError: true }),
  );
}

/** HTTP の MCP サーバーを立てる。 */
function startHttpMcpServer() {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "terasuma-test-http", version: "1.0.0" });
    registerTestTools(server, "http");
    return server;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handler.fetch(request),
  });

  return { server, url: `http://127.0.0.1:${server.port}/mcp` };
}

/** 一時ディレクトリに本物の設定ファイルを作り、そこを指す manager を渡す。 */
async function withManager(
  servers: McpServersSettings,
  run: (manager: McpManager) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-mcp-"));
  const path = join(dir, CONFIG_FILE_NAME);
  writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");

  const manager = createMcpManager({
    settings: createSettingsStore(path),
    dataDir: dir,
    callbackUrl: () => new URL(CALLBACK_URL),
  });

  try {
    await run(manager);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** テスト用のローカルサーバー。テストを走らせている bun 自身で起動する。 */
function stdioServer(id: string) {
  return {
    id,
    server: {
      type: "stdio" as const,
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures", "mcp-stdio-server.ts")],
    },
  };
}

describe("MCP サーバーとの接続", () => {
  test("ローカルのサーバーに繋がり、公開しているツールが分かる", async () => {
    const { id, server } = stdioServer("local");
    await withManager({ [id]: server }, async (manager) => {
      expect(manager.status(id).state).toBe("unknown");

      const status = await manager.check(id);
      expect(status.state).toBe("connected");
      expect(status.detail).toBeNull();
      expect([...status.tools].sort()).toEqual(["echo", "fail"]);
    });
  });

  test("HTTP のサーバーにも繋がる", async () => {
    const http = startHttpMcpServer();
    try {
      await withManager({ remote: { type: "http", url: http.url } }, async (manager) => {
        const status = await manager.check("remote");
        expect(status.state).toBe("connected");
        expect([...status.tools].sort()).toEqual(["echo", "fail"]);
      });
    } finally {
      await http.server.stop(true);
    }
  });

  test("モデルへ渡すツール名はサーバー id で始まる", async () => {
    const { id, server } = stdioServer("local");
    await withManager({ [id]: server }, async (manager) => {
      const tools = await manager.toolset();
      expect(Object.keys(tools).sort()).toEqual(["local_echo", "local_fail"]);

      // 実際に呼べることまで確かめる。
      const echo = tools["local_echo"];
      if (echo === undefined) throw new Error("echo が無い");
      await expect(echo.execute?.({ text: "こんにちは" }, {} as never)).resolves.toBeDefined();
    });
  });

  test("繋がらないサーバーは理由を添えて failed になる", async () => {
    await withManager(
      { broken: { type: "stdio", command: "/nonexistent/terasuma-mcp-server" } },
      async (manager) => {
        const status = await manager.check("broken");
        expect(status.state).toBe("failed");
        expect(status.detail).not.toBeNull();
        expect(status.tools).toEqual([]);
      },
    );
  });

  test("設定に無いサーバーは触れない", async () => {
    await withManager({}, async (manager) => {
      await expect(manager.check("missing")).rejects.toBeInstanceOf(McpServerNotFound);
      await expect(manager.authorize("missing")).rejects.toBeInstanceOf(McpServerNotFound);
    });
  });

  test("接続できないサーバーがあっても、他のサーバーのツールは使える", async () => {
    const { id, server } = stdioServer("local");
    await withManager(
      { [id]: server, broken: { type: "stdio", command: "/nonexistent/terasuma-mcp-server" } },
      async (manager) => {
        const tools = await manager.toolset();
        expect(Object.keys(tools).sort()).toEqual(["local_echo", "local_fail"]);
      },
    );
  });
});

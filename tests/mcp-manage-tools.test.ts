import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { ToolSet } from "ai";
import { z } from "zod";
import { CONFIG_FILE_NAME } from "../src/config";
import { createImageStore } from "../src/server/computer/images";
import { createSettingsStore, type SettingsStore } from "../src/server/data/settings";
import { createMcpManageToolset } from "../src/server/mcp/manage";
import { createMcpManager, type McpManager } from "../src/server/mcp/manager";
import { MCP_ADD_SERVER_TOOL_NAME, MCP_REMOVE_SERVER_TOOL_NAME } from "../src/shared/tools";

/** コールバックの URL。認可を使わないテストでは開かれない。 */
const CALLBACK_URL = "http://127.0.0.1:9/api/mcp/oauth/callback";

/** テスト用の MCP サーバー。 */
function createTestServer(name: string): McpServer {
  const server = new McpServer({ name: `terasuma-manage-${name}`, version: "1.0.0" });

  server.registerTool("echo", { description: `${name} の echo`, inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }));

  return server;
}

/** HTTP の MCP サーバーを立てる。 */
function startHttpMcpServer() {
  const handler = createMcpHandler(() => createTestServer("http"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler.fetch(request) });

  return { server, url: `http://127.0.0.1:${server.port}/mcp` };
}

/** テスト用のローカルサーバー。テストを走らせている bun 自身で起動する。 */
const STDIO_SERVER = {
  type: "stdio" as const,
  command: process.execPath,
  args: [join(import.meta.dir, "fixtures", "mcp-stdio-server.ts")],
};

type Harness = {
  manager: McpManager;
  settings: SettingsStore;
  tools: ToolSet;
  configPath: string;
};

/** 一時ディレクトリに本物の設定ファイルを作り、manage ツールを組んで渡す。 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-mcp-manage-"));
  const configPath = join(dir, CONFIG_FILE_NAME);
  writeFileSync(configPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, "utf8");

  const images = createImageStore(dir);
  const settings = createSettingsStore(configPath);
  const manager = createMcpManager({
    settings,
    dataDir: dir,
    images,
    callbackUrl: () => new URL(CALLBACK_URL),
  });
  const tools = createMcpManageToolset({ settings, mcp: manager }).toolset();

  try {
    await run({ manager, settings, tools, configPath });
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ツールを 1 つ実行し、本文を返す。 */
async function callTool(tools: ToolSet, name: string, input: unknown): Promise<string> {
  const definition = tools[name] as { execute?: (value: never, options: never) => unknown } | undefined;
  if (definition?.execute === undefined) throw new Error(`${name} が無いか、実行を持っていません`);

  const output = await definition.execute(input as never, { toolCallId: "call-1", messages: [] } as never);
  if (typeof output !== "string") throw new Error(`${name} の戻り値が文字列ではありません`);
  return output;
}

describe("mcp_add_server", () => {
  test("http のサーバーを足すと、設定に保存され、その場でツールが見つかる", async () => {
    const http = startHttpMcpServer();
    try {
      await withHarness(async ({ manager, settings, tools, configPath }) => {
        const text = await callTool(tools, MCP_ADD_SERVER_TOOL_NAME, {
          id: "remote",
          type: "http",
          url: http.url,
        });

        expect(text).toContain('Added MCP server "remote" (http).');
        expect(text).toContain("remote_echo");
        expect(text).toContain("tool_search");
        expect(text).toContain("tool_call");

        expect(settings.read().mcpServers.remote).toEqual({ type: "http", url: http.url });
        const file = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
        expect(file.mcpServers["remote"]).toEqual({ type: "http", url: http.url });

        expect(Object.keys(await manager.toolset()).sort()).toEqual(["remote_echo"]);
      });
    } finally {
      await http.server.stop(true);
    }
  });

  test("同じ id をもう一度足すと失敗し、設定は 1 件のまま", async () => {
    const http = startHttpMcpServer();
    try {
      await withHarness(async ({ settings, tools }) => {
        await callTool(tools, MCP_ADD_SERVER_TOOL_NAME, { id: "remote", type: "http", url: http.url });

        await expect(
          callTool(tools, MCP_ADD_SERVER_TOOL_NAME, { id: "remote", type: "http", url: http.url }),
        ).rejects.toThrow('An MCP server with id "remote" already exists');

        expect(Object.keys(settings.read().mcpServers)).toEqual(["remote"]);
      });
    } finally {
      await http.server.stop(true);
    }
  });

  test("env は引数に無いので、渡しても保存されない", async () => {
    await withHarness(async ({ manager, settings, tools }) => {
      const text = await callTool(tools, MCP_ADD_SERVER_TOOL_NAME, {
        id: "local",
        ...STDIO_SERVER,
        env: { SECRET_TOKEN: "do-not-save" },
      });

      expect(text).toContain('Added MCP server "local" (stdio).');
      expect(text).toContain("local_echo");

      const saved = settings.read().mcpServers.local;
      expect(saved).toEqual(STDIO_SERVER);
      expect(saved !== undefined && "env" in saved).toBe(false);
      expect(Object.keys(await manager.toolset())).toContain("local_echo");
    });
  });

  test("不正な id は失敗し、何も保存されない", async () => {
    await withHarness(async ({ settings, tools }) => {
      for (const id of ["Bad", "bad_id", "computer", "mcp"]) {
        await expect(
          callTool(tools, MCP_ADD_SERVER_TOOL_NAME, { id, type: "http", url: "http://127.0.0.1:1/mcp" }),
        ).rejects.toThrow();
        expect(settings.read().mcpServers).toEqual({});
      }
    });
  });

  test("繋がらないサーバーでも例外にせず、設定を残して理由を返す", async () => {
    await withHarness(async ({ manager, settings, tools }) => {
      const text = await callTool(tools, MCP_ADD_SERVER_TOOL_NAME, {
        id: "broken",
        type: "http",
        url: "http://127.0.0.1:1/mcp",
      });

      expect(text).toContain('Added MCP server "broken" (http).');
      expect(text).toContain("could not connect");
      expect(text).toContain("settings are saved");
      expect(settings.read().mcpServers.broken).toEqual({ type: "http", url: "http://127.0.0.1:1/mcp" });
      expect(manager.status("broken").state).toBe("failed");
    });
  });
});

describe("mcp_remove_server", () => {
  test("設定からもツールからも消え、無い id は失敗する", async () => {
    const http = startHttpMcpServer();
    try {
      await withHarness(async ({ manager, settings, tools }) => {
        await callTool(tools, MCP_ADD_SERVER_TOOL_NAME, { id: "remote", type: "http", url: http.url });
        expect(Object.keys(await manager.toolset())).toContain("remote_echo");

        const text = await callTool(tools, MCP_REMOVE_SERVER_TOOL_NAME, { id: "remote" });
        expect(text).toContain('Removed MCP server "remote".');
        expect(text).toContain("no longer available");

        expect(settings.read().mcpServers.remote).toBeUndefined();
        expect(await manager.toolset()).toEqual({});

        await expect(callTool(tools, MCP_REMOVE_SERVER_TOOL_NAME, { id: "missing" })).rejects.toThrow(
          'No MCP server has id "missing"',
        );
      });
    } finally {
      await http.server.stop(true);
    }
  });
});

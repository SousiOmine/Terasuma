import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

/**
 * テストで使う最小の MCP サーバー。標準入出力で話す。
 * 接続とツール呼び出しが通ることを確かめるためのもので、外部には何もしない。
 */
serveStdio(() => {
  const server = new McpServer({ name: "terasuma-test-stdio", version: "1.0.0" });

  server.registerTool(
    "echo",
    { description: "渡された文字列をそのまま返す", inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );

  server.registerTool(
    "fail",
    { description: "いつも失敗を返す", inputSchema: { reason: z.string() } },
    ({ reason }) => ({ content: [{ type: "text", text: `失敗: ${reason}` }], isError: true }),
  );

  return server;
});

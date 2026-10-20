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

  // 1x1 の PNG。ツールの戻り値で画像を返せることを確かめるために使う。
  const PNG_1X1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  server.registerTool(
    "shot",
    { description: "画像を返す", inputSchema: {} },
    () => ({
      content: [
        { type: "text" as const, text: "撮りました" },
        { type: "image" as const, data: PNG_1X1, mimeType: "image/png" },
      ],
    }),
  );

  return server;
});

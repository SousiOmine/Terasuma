import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CONFIG_FILE_NAME, type McpServerSettings, type McpServersSettings } from "../src/config";
import { McpServerNotFound, createMcpManager, type McpManager } from "../src/server/mcp";
import { createImageStore, type ImageStore } from "../src/server/images";
import { createSettingsStore } from "../src/server/settings";
import type { ImageRef } from "../src/shared/types";
import { startFakeOAuthServer } from "./fixtures/oauth-server";
import { testPng } from "./support";

/** コールバックの URL。認可を使わないテストでは開かれない。 */
const CALLBACK_URL = "http://127.0.0.1:9/api/mcp/oauth/callback";

/** テスト用の MCP サーバー。 */
function createTestServer(name: string): McpServer {
  const server = new McpServer({ name: `terasuma-test-${name}`, version: "1.0.0" });

  server.registerTool(
    "echo",
    { description: `${name} の echo`, inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );

  server.registerTool(
    "fail",
    { description: `${name} の fail`, inputSchema: { reason: z.string() } },
    ({ reason }) => ({ content: [{ type: "text", text: `失敗: ${reason}` }], isError: true }),
  );

  // 画像を返すツール。ツールの戻り値に画像を載せられることを確かめる。
  server.registerTool(
    "shot",
    { description: `${name} の shot`, inputSchema: {} },
    () => ({
      content: [
        { type: "text" as const, text: "撮りました" },
        { type: "image" as const, data: Buffer.from(testPng(3, 2)).toString("base64"), mimeType: "image/png" },
      ],
    }),
  );

  return server;
}

/** テスト用の MCP サーバーの fetch ハンドラ。認可で守るサーバーに載せるときにも使う。 */
function mcpHandler(name: string) {
  const handler = createMcpHandler(() => createTestServer(name));
  return (request: Request) => handler.fetch(request);
}

/** HTTP の MCP サーバーを立てる。 */
function startHttpMcpServer() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: mcpHandler("http"),
  });

  return { server, url: `http://127.0.0.1:${server.port}/mcp` };
}

/** 一時ディレクトリに本物の設定ファイルを作り、そこを指す manager を渡す。 */
async function withManager(
  servers: McpServersSettings,
  run: (manager: McpManager, images: ImageStore) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-mcp-"));
  const path = join(dir, CONFIG_FILE_NAME);
  writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");

  const images = createImageStore(dir);
  const manager = createMcpManager({
    settings: createSettingsStore(path),
    dataDir: dir,
    images,
    callbackUrl: () => new URL(CALLBACK_URL),
  });

  try {
    await run(manager, images);
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
      expect([...status.tools].sort()).toEqual(["echo", "fail", "shot"]);
    });
  });

  test("HTTP のサーバーにも繋がる", async () => {
    const http = startHttpMcpServer();
    try {
      await withManager({ remote: { type: "http", url: http.url } }, async (manager) => {
        const status = await manager.check("remote");
        expect(status.state).toBe("connected");
        expect([...status.tools].sort()).toEqual(["echo", "fail", "shot"]);
      });
    } finally {
      await http.server.stop(true);
    }
  });

  test("認可を求める HTTP のサーバーは、認可が必要な状態になる", async () => {
    const as = startFakeOAuthServer({ mcp: mcpHandler("http") });
    try {
      await withManager({ remote: { type: "http", url: `${as.issuer}/mcp` } }, async (manager) => {
        const status = await manager.check("remote");
        expect(status.state).toBe("authorization_required");
        // 次にすることは画面の「認可する」が示すので、SDK の内部的な失敗理由は出さない。
        expect(status.detail).toBeNull();
        expect(status.tools).toEqual([]);
      });
    } finally {
      await as.server.stop(true);
    }
  });

  test("保存ずみのサーバーでも、認可を始めて繋がるところまで進める", async () => {
    const as = startFakeOAuthServer({ mcp: mcpHandler("http") });
    try {
      await withManager({ remote: { type: "http", url: `${as.issuer}/mcp` } }, async (manager) => {
        const started = await manager.authorize("remote");
        const authorizationUrl = started.url;
        if (authorizationUrl === null) throw new Error("認可の URL が返らなかった");
        expect(authorizationUrl).toContain(`${as.issuer}/authorize`);

        // 認可を待っている間は繋ぎに行かない（認可の要求が作り直されない）。
        expect(await manager.check("remote")).toEqual({ state: "authorizing", tools: [], detail: null });

        const url = new URL(authorizationUrl);
        await manager.completeAuthorization(url.searchParams.get("state") ?? "", {
          code: as.approve(url),
          iss: null,
          error: null,
        });

        const status = await manager.check("remote");
        expect(status.state).toBe("connected");
        expect([...status.tools].sort()).toEqual(["echo", "fail", "shot"]);
      });
    } finally {
      await as.server.stop(true);
    }
  });

  test("認可の用意が無い 401 は、認可ではなく失敗として扱う", async () => {    const unauthorized = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("unauthorized", { status: 401 }),
    });

    try {
      await withManager(
        { remote: { type: "http", url: `http://127.0.0.1:${unauthorized.port}/mcp` } },
        async (manager) => {
          const status = await manager.check("remote");
          expect(status.state).toBe("failed");
          expect(status.detail).not.toBeNull();
        },
      );
    } finally {
      await unauthorized.stop(true);
    }
  });

  test("モデルへ渡すツール名はサーバー id で始まる", async () => {
    const { id, server } = stdioServer("local");
    await withManager({ [id]: server }, async (manager) => {
      const tools = await manager.toolset();
      expect(Object.keys(tools).sort()).toEqual(["local_echo", "local_fail", "local_shot"]);

      // 実際に呼べることまで確かめる。
      // expect(...).resolves で待つと、MCP の応答を受け取る前に要求が時間切れになる
      // （Bun 1.4.3 で再現）。値を待ってから確かめる。
      const echo = tools["local_echo"];
      if (echo === undefined) throw new Error("echo が無い");
      const result = await echo.execute?.({ text: "こんにちは" }, {} as never);
      expect(result).toBeDefined();
    });
  });

  test("ツールが返した画像は保存され、参照つきで返る", async () => {
    const { id, server } = stdioServer("local");
    await withManager({ [id]: server }, async (manager, images) => {
      const tools = await manager.toolset();
      const shot = tools["local_shot"];
      if (shot?.execute === undefined) throw new Error("shot が無い");

      const output = (await shot.execute({}, {} as never)) as { text: string; images?: ImageRef[] };
      expect(output.text).toBe("撮りました");
      expect(output.images).toHaveLength(1);

      const image = output.images?.[0];
      if (image === undefined) throw new Error("画像の参照が無い");

      expect(image.mime).toBe("image/png");
      expect(image.width).toBe(1);
      expect(image.height).toBe(1);
      // 保存した実体を参照から読み直せる（会話には base64 を残さない）。
      expect(images.read(image)?.subarray(0, 8)).toEqual(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
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
        expect(Object.keys(tools).sort()).toEqual(["local_echo", "local_fail", "local_shot"]);
      },
    );
  });
});

describe("保存する前の接続の確認", () => {
  test("設定に書かずに繋がりを確かめられる", async () => {
    const { id, server } = stdioServer("candidate");
    await withManager({}, async (manager) => {
      const result = await manager.test(id, server);
      expect(result.state).toBe("connected");
      expect([...result.tools].sort()).toEqual(["echo", "fail", "shot"]);
      expect(result.authorizationUrl).toBeNull();

      // 確かめただけなので、接続の一覧はまだ何も知らない。
      expect(manager.status(id).state).toBe("unknown");
    });
  });

  test("繋がらない設定は、理由を添えて failed になる", async () => {
    await withManager({}, async (manager) => {
      const result = await manager.test("broken", { type: "stdio", command: "/nonexistent/terasuma-mcp-server" });
      expect(result.state).toBe("failed");
      expect(result.detail).not.toBeNull();
      expect(result.authorizationUrl).toBeNull();
    });
  });

  test("認可が要るサーバーは、開く URL とともに待ち状態になる", async () => {
    const as = startFakeOAuthServer({ mcp: mcpHandler("http") });
    try {
      const server: McpServerSettings = { type: "http", url: `${as.issuer}/mcp` };

      await withManager({}, async (manager) => {
        const started = await manager.test("remote", server);
        expect(started.state).toBe("authorization_required");
        expect(started.authorizationUrl).toContain(`${as.issuer}/authorize`);

        // 認可を待っている間は繋ぎに行かない（認可の要求が作り直されない）。
        const waiting = await manager.test("remote", server);
        expect(waiting.state).toBe("authorizing");
        expect(waiting.authorizationUrl).toBe(started.authorizationUrl);

        // 別の接続先を確かめると、待っていた認可は捨ててやり直す。
        const other = await manager.test("remote", { type: "http", url: `${as.issuer}/mcp?other=1` });
        expect(other.state).toBe("authorization_required");
        expect(other.authorizationUrl).not.toBe(started.authorizationUrl);
      });
    } finally {
      await as.server.stop(true);
    }
  });

  test("保存前の確認で始めた認可は、コールバックで終わらせて、そのまま繋がる", async () => {
    const as = startFakeOAuthServer({ mcp: mcpHandler("http") });
    try {
      const server: McpServerSettings = { type: "http", url: `${as.issuer}/mcp` };

      await withManager({}, async (manager) => {
        const started = await manager.test("remote", server);
        const authorizationUrl = started.authorizationUrl;
        if (authorizationUrl === null) throw new Error("認可の URL が返らなかった");

        // ブラウザで認可したことにして、コールバックと同じ順で終わらせる。
        const url = new URL(authorizationUrl);
        const done = await manager.completeAuthorization(url.searchParams.get("state") ?? "", {
          code: as.approve(url),
          iss: null,
          error: null,
        });
        expect(done).toEqual({ serverId: "remote" });

        // トークンが保存されたので、次は認可を求めずに繋がる。
        const result = await manager.test("remote", server);
        expect(result.state).toBe("connected");
        expect([...result.tools].sort()).toEqual(["echo", "fail", "shot"]);
      });
    } finally {
      await as.server.stop(true);
    }
  });
});

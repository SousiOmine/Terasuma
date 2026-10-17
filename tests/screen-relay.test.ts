import { describe, expect, test } from "bun:test";
import { SCREEN_RELAY_PREFIX } from "../src/server/routes";
import { createMockEngine } from "../src/server/engine";
import { startServer } from "../src/server/server";
import { createStore } from "../src/server/store";
import type { ContainerManager } from "../src/server/container";
import { createHandover } from "../src/server/handover";
import { TEST_SETTINGS, createContainerStub, createMcpStub, createMemoryStub, withTempSettings } from "./support";

/**
 * 画面の中継の確認。
 * コンテナの中の websockify は偽の HTTP サーバーに置き換え、中継がパスと問い合わせを保つかを見る。
 */

/** 偽の websockify。受け取ったパスと問い合わせを記録して返す。 */
function startFakeScreen() {
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);

      if (url.pathname === "/missing") return new Response("not found", { status: 404 });
      return new Response(`content of ${url.pathname}`, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  return { server, requests };
}

function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("偽のサーバーのポートが取れていない");
  return server.port;
}

async function withScreenServer<T>(
  container: ContainerManager,
  run: (request: (path: string) => Promise<Response>) => Promise<T>,
): Promise<T> {
  return withTempSettings(TEST_SETTINGS, async (settings) => {
    const store = createStore(":memory:");
    const { server } = startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        configDir: ".",
        configPath: "./config.json",
        dataDir: ".",
        dbPath: ":memory:",
        engine: "mock",
        isDevelopment: false,
      },
      store,
      engine: createMockEngine({ chunkSize: 10_000, delayMs: 0 }),
      memory: createMemoryStub(store),
      settings,
      mcp: createMcpStub(),
      container,
      handover: createHandover(),
    });

    try {
      return await run((path) => fetch(new URL(path, server.url)));
    } finally {
      await server.stop(true);
    }
  });
}

describe("画面の中継", () => {
  test("コンテナが動いていなければ、理由付きで断る", async () => {
    await withScreenServer(createContainerStub(), async (request) => {
      const response = await request(`${SCREEN_RELAY_PREFIX}vnc.html`);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("container_not_running");
    });
  });

  test("中継の接頭辞を落としたパスで、コンテナへ取りに行く", async () => {
    const fake = startFakeScreen();

    try {
      await withScreenServer(createContainerStub({ vncPort: portOf(fake.server) }), async (request) => {
        const response = await request(`${SCREEN_RELAY_PREFIX}core/rfb.js`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("content of /core/rfb.js");
        // noVNC の JS はキャッシュを避ける（古いものが残ると原因が分かりにくい）。
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      });

      expect(fake.requests).toEqual(["/core/rfb.js"]);
    } finally {
      await fake.server.stop(true);
    }
  });

  test("問い合わせはそのまま渡す", async () => {
    const fake = startFakeScreen();

    try {
      await withScreenServer(createContainerStub({ vncPort: portOf(fake.server) }), async (request) => {
        await request(`${SCREEN_RELAY_PREFIX}vnc.html?autoconnect=1&resize=scale`);
      });

      expect(fake.requests).toEqual(["/vnc.html?autoconnect=1&resize=scale"]);
    } finally {
      await fake.server.stop(true);
    }
  });

  test("コンテナ側の状態と種類をそのまま返す", async () => {
    const fake = startFakeScreen();

    try {
      await withScreenServer(createContainerStub({ vncPort: portOf(fake.server) }), async (request) => {
        const missing = await request(`${SCREEN_RELAY_PREFIX}missing`);
        expect(missing.status).toBe(404);

        const found = await request(`${SCREEN_RELAY_PREFIX}vnc.html`);
        expect(found.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      });
    } finally {
      await fake.server.stop(true);
    }
  });
});

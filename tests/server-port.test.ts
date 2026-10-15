import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { createMockEngine } from "../src/server/engine";
import { startServer, type StartedServer } from "../src/server/server";
import { createStore } from "../src/server/store";
import { createHandover } from "../src/server/handover";
import { TEST_SETTINGS, createContainerStub, createImageStub, createMcpStub, withTempSettings } from "./support";

/** ポートだけを差し替えて使う設定。 */
function makeConfig(port: number): AppConfig {
  return {
    host: "127.0.0.1",
    port,
    configDir: ".",
    configPath: "./config.json",
    dataDir: ".",
    dbPath: ":memory:",
    engine: "mock",
    isDevelopment: false,
  };
}

/** 指定したポートでサーバを起動し、テストが終わったら必ず止める。 */
async function withServerOn<T>(port: number, run: (started: StartedServer) => Promise<T>): Promise<T> {
  return withTempSettings(TEST_SETTINGS, async (settings) => {
    const started = startServer({
      config: makeConfig(port),
      store: createStore(":memory:"),
      engine: createMockEngine({ chunkSize: 10_000, delayMs: 0 }),
      settings,
      mcp: createMcpStub(),
      container: createContainerStub(),
      images: createImageStub(),
      handover: createHandover(),
    });

    try {
      return await run(started);
    } finally {
      await started.server.stop(true);
    }
  });
}

/** TCP で待ち受けているサーバのポートを取り出す（型の上では undefined になり得るため確かめる）。 */
function listeningPort(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("ポートが割り当てられていない");
  return server.port;
}

/** 空いているポートを 1 つ確保して、すぐ手放す。希望のポートとして使う番号を得るために使う。 */
async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = listeningPort(probe);
  await probe.stop(true);
  return port;
}

describe("サーバの起動ポート", () => {
  test("設定したポートが空いていれば、そのポートで起動する", async () => {
    const port = await pickFreePort();

    await withServerOn(port, async ({ server, portChanged }) => {
      expect(portChanged).toBe(false);
      expect(server.port).toBe(port);
    });
  });

  test("設定したポートが埋まっていたら、空いているポートで起動する", async () => {
    // 先に同じポートを押さえて、埋まっている状態を作る。
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("埋まっている", { status: 503 }),
    });

    const port = listeningPort(blocker);

    try {
      await withServerOn(port, async ({ server, portChanged }) => {
        expect(portChanged).toBe(true);
        expect(server.port).not.toBe(port);

        // 選ばれたポートで、API が普通に応答する。
        const response = await fetch(new URL("/api/sessions", server.url));
        expect(response.status).toBe(200);
      });
    } finally {
      await blocker.stop(true);
    }
  });

  test("ポートの確保以外の失敗では、空きポートへ逃げずに起動を止める", async () => {
    // ポート番号が範囲外なのは設定の検証で弾かれる値だが、listen 以外の失敗を
    // 空きポートで握り潰さないことをここで確かめる（握り潰すと設定ミスに気づけない）。
    await withTempSettings(TEST_SETTINGS, async (settings) => {
      const attempt = () =>
        startServer({
          config: makeConfig(70_000),
          store: createStore(":memory:"),
          engine: createMockEngine({ chunkSize: 10_000, delayMs: 0 }),
          settings,
          mcp: createMcpStub(),
          container: createContainerStub(),
          images: createImageStub(),
          handover: createHandover(),
        });

      expect(attempt).toThrow();
    });
  });
});

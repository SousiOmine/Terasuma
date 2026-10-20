import { describe, expect, test } from "bun:test";
import { portOf, withServer } from "./harness";

/** 空いているポートを 1 つ確保して、すぐ手放す。希望のポートとして使う番号を得るために使う。 */
async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = portOf(probe);
  await probe.stop(true);
  return port;
}

describe("サーバの起動ポート", () => {
  test("設定したポートが空いていれば、そのポートで起動する", async () => {
    const port = await pickFreePort();

    await withServer(
      ({ server, portChanged }) => {
        expect(portChanged).toBe(false);
        expect(server.port).toBe(port);
        return Promise.resolve();
      },
      { port },
    );
  });

  test("設定したポートが埋まっていたら、空いているポートで起動する", async () => {
    // 先に同じポートを押さえて、埋まっている状態を作る。
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("埋まっている", { status: 503 }),
    });

    const port = portOf(blocker);

    try {
      await withServer(
        async ({ server, portChanged }) => {
          expect(portChanged).toBe(true);
          expect(server.port).not.toBe(port);

          // 選ばれたポートで、API が普通に応答する。
          const response = await fetch(new URL("/api/teras", server.url));
          expect(response.status).toBe(200);
        },
        // 空きポートへ逃げるのは開発時だけ。
        { port, isDevelopment: true },
      );
    } finally {
      await blocker.stop(true);
    }
  });

  test("本番は、設定したポートが埋まっていたら起動しない", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = portOf(blocker);

    try {
      await expect(withServer(async () => undefined, { port })).rejects.toThrow(/使用中/);
    } finally {
      await blocker.stop(true);
    }
  });

  test("ポートの確保以外の失敗では、空きポートへ逃げずに起動を止める", async () => {
    // ポート番号が範囲外なのは設定の検証で弾かれる値だが、listen 以外の失敗を
    // 空きポートで握り潰さないことをここで確かめる（握り潰すと設定ミスに気づけない）。
    await expect(withServer(async () => undefined, { port: 70_000 })).rejects.toThrow();
  });
});

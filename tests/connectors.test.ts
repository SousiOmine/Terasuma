import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnectors, type ConnectorsManager } from "../src/server/connectors/manager";
import { ConnectorNotFound } from "../src/server/errors";
import { withTempDir } from "./harness";
import { fakeProvider, startFakeConnectorServer, type FakeConnectorServer } from "./fixtures/connector-server";

/**
 * コネクタ（トークン）。
 * トークンは偽の API サーバーで検証し、待ちは setToken で解く。
 * Discord は Tera ごとの webhook なので、ここではなく tests/discord.test.ts が確かめる。
 */

type Context = {
  manager: ConnectorsManager;
  dir: string;
  server: FakeConnectorServer;
};

/** 偽の接続先と、一時ディレクトリのトークン置き場を用意する。 */
async function withConnectors(run: (context: Context) => Promise<void>): Promise<void> {
  const server = startFakeConnectorServer();
  try {
    await withTempDir("terasuma-connectors-", async (dir) => {
      const manager = createConnectors({ dataDir: join(dir, "data"), providers: [fakeProvider(server)] });

      try {
        await run({ manager, dir, server });
      } finally {
        manager.close();
      }
    });
  } finally {
    await server.server.stop(true);
  }
}

/** ターンが続いている状態の signal。 */
function signal(): AbortSignal {
  return new AbortController().signal;
}

/**
 * 失敗するまで待って、理由を 1 文で返す。
 * Bun 1.4.3 の expect(...).rejects は未解決の promise を待ってくれるが、
 * その場で待ちに入ってしまうため、トリガーより前に呼ぶテストでは使えない。
 */
function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "(resolved)",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("コネクタ", () => {
  test("トークンを保存すると、接続済みになり環境変数に載る", async () => {
    await withConnectors(async ({ manager, dir, server }) => {
      const view = await manager.setToken("github", server.accessToken);

      expect(view.providers[0]).toMatchObject({
        connected: true,
        account: server.account,
        detail: null,
      });

      // コンピュータへ渡す値と、画面に出すアカウント。
      expect(manager.env()).toEqual({ GH_TOKEN: server.accessToken, GITHUB_TOKEN: server.accessToken });

      // トークンは本人だけが読める権限で保存する。
      const tokenPath = join(dir, "data", "connectors", "github.json");
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

      const connected = await manager.wait("github", signal());
      expect(connected).toContain(`@${server.account}`);
      expect(connected).toContain("$GH_TOKEN");
    });
  });

  test("受け付けられないトークンは保存しない", async () => {
    await withConnectors(async ({ manager, dir }) => {
      expect(await rejectionOf(manager.setToken("github", "wrong"))).toMatch(/did not accept the token/);

      expect(manager.token("github")).toBeNull();
      expect(existsSync(join(dir, "data", "connectors", "github.json"))).toBe(false);
    });
  });

  test("トークンが無ければ、保存を待つ", async () => {
    await withConnectors(async ({ manager }) => {
      const waiting = manager.wait("github", signal());
      const rejected = rejectionOf(waiting);

      manager.cancelWait("github");
      expect(await rejected).toMatch(/cancelled/);
    });
  });

  test("同じアプリの待ちは、トークン保存でまとめて解ける", async () => {
    await withConnectors(async ({ manager, server }) => {
      const first = manager.wait("github", signal());
      const second = manager.wait("github", signal());

      await manager.setToken("github", server.accessToken);

      expect(await first).toContain(`@${server.account}`);
      expect(await second).toContain(`@${server.account}`);
    });
  });

  test("ターンが止まると、待ちは外れる", async () => {
    await withConnectors(async ({ manager }) => {
      const controller = new AbortController();
      const waiting = manager.wait("github", controller.signal);
      const rejected = rejectionOf(waiting);

      controller.abort();
      expect(await rejected).toMatch(/turn ended/);
    });
  });

  test("接続済みなら、待たずに使い方を返す", async () => {
    await withConnectors(async ({ manager, server }) => {
      await manager.setToken("github", server.accessToken);

      const again = await manager.wait("github", signal());
      expect(again).toContain("is connected");
      expect(again).toContain("$GH_TOKEN");
    });
  });

  test("切断すると、保存したトークンも消える", async () => {
    await withConnectors(async ({ manager, dir, server }) => {
      await manager.setToken("github", server.accessToken);

      const tokenPath = join(dir, "data", "connectors", "github.json");
      expect(existsSync(tokenPath)).toBe(true);

      manager.disconnect("github");

      expect(existsSync(tokenPath)).toBe(false);
      expect(manager.env()).toEqual({});
      expect(manager.view().providers[0]?.account).toBeNull();
    });
  });

  test("保存されているトークンが壊れていたら、理由を出す", async () => {
    await withConnectors(async ({ manager, dir }) => {
      const tokenDir = join(dir, "data", "connectors");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(join(tokenDir, "github.json"), "{ not json", "utf8");

      expect(manager.view().providers[0]?.detail).not.toBeNull();
      expect(manager.env()).toEqual({});
      expect(await rejectionOf(manager.wait("github", signal()))).toMatch(/could not be read/);
    });
  });

  test("知らないコネクタ id は失敗する", async () => {
    await withConnectors(async ({ manager }) => {
      expect(() => manager.provider("unknown")).toThrow(ConnectorNotFound);
    });
  });
});

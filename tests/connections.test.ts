import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnections, type ConnectionsManager } from "../src/server/connections/manager";
import type { ConnectionProvider } from "../src/server/connections/providers";
import { createSettingsStore, type SettingsStore } from "../src/server/data/settings";
import { ConnectionNotFound } from "../src/server/errors";
import { withTempDir } from "./harness";
import {
  fakeBotProvider,
  fakeProvider,
  startFakeConnectionServer,
  type FakeConnectionServer,
} from "./fixtures/connection-server";

/**
 * アプリの接続（トークン）。
 * トークンは偽の API サーバーで検証し、待ちは setToken で解く。
 */

type Context = {
  manager: ConnectionsManager;
  settings: SettingsStore;
  dir: string;
  server: FakeConnectionServer;
};

/** 偽の接続先と、一時ディレクトリの設定・トークン置き場を用意する。 */
async function withConnections(
  run: (context: Context) => Promise<void>,
  extraProviders: (server: FakeConnectionServer) => ConnectionProvider[] = () => [],
): Promise<void> {
  const server = startFakeConnectionServer();
  try {
    await withTempDir("terasuma-connections-", async (dir) => {
      const settings = createSettingsStore(join(dir, "config.json"));
      const manager = createConnections({
        settings,
        dataDir: join(dir, "data"),
        providers: [fakeProvider(server), ...extraProviders(server)],
      });

      try {
        await run({ manager, settings, dir, server });
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

describe("アプリの接続", () => {
  test("トークンを保存すると、接続済みになり環境変数に載る", async () => {
    await withConnections(async ({ manager, dir, server }) => {
      const view = await manager.setToken("github", server.accessToken);

      expect(view.providers[0]).toMatchObject({
        connected: true,
        account: server.account,
        clientId: null,
        needsClientId: false,
        detail: null,
      });

      // コンピュータへ渡す値と、画面に出すアカウント。
      expect(manager.env()).toEqual({ GH_TOKEN: server.accessToken, GITHUB_TOKEN: server.accessToken });

      // トークンは本人だけが読める権限で保存する。
      const tokenPath = join(dir, "data", "connections", "github.json");
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

      const connected = await manager.wait("github", signal());
      expect(connected).toContain(`@${server.account}`);
      expect(connected).toContain("$GH_TOKEN");
    });
  });

  test("受け付けられないトークンは保存しない", async () => {
    await withConnections(async ({ manager, dir }) => {
      expect(await rejectionOf(manager.setToken("github", "wrong"))).toMatch(/did not accept the token/);

      expect(manager.token("github")).toBeNull();
      expect(existsSync(join(dir, "data", "connections", "github.json"))).toBe(false);
    });
  });

  test("トークンが無ければ、保存を待つ", async () => {
    await withConnections(async ({ manager }) => {
      const waiting = manager.wait("github", signal());
      const rejected = rejectionOf(waiting);

      manager.cancelWait("github");
      expect(await rejected).toMatch(/cancelled/);
    });
  });

  test("同じアプリの待ちは、トークン保存でまとめて解ける", async () => {
    await withConnections(async ({ manager, server }) => {
      const first = manager.wait("github", signal());
      const second = manager.wait("github", signal());

      await manager.setToken("github", server.accessToken);

      expect(await first).toContain(`@${server.account}`);
      expect(await second).toContain(`@${server.account}`);
    });
  });

  test("ターンが止まると、待ちは外れる", async () => {
    await withConnections(async ({ manager }) => {
      const controller = new AbortController();
      const waiting = manager.wait("github", controller.signal);
      const rejected = rejectionOf(waiting);

      controller.abort();
      expect(await rejected).toMatch(/turn ended/);
    });
  });

  test("接続済みなら、待たずに使い方を返す", async () => {
    await withConnections(async ({ manager, server }) => {
      await manager.setToken("github", server.accessToken);

      const again = await manager.wait("github", signal());
      expect(again).toContain("is connected");
      expect(again).toContain("$GH_TOKEN");
    });
  });

  test("切断すると、保存したトークンも消える", async () => {
    await withConnections(async ({ manager, dir, server }) => {
      await manager.setToken("github", server.accessToken);

      const tokenPath = join(dir, "data", "connections", "github.json");
      expect(existsSync(tokenPath)).toBe(true);

      manager.disconnect("github");

      expect(existsSync(tokenPath)).toBe(false);
      expect(manager.env()).toEqual({});
      expect(manager.view().providers[0]?.account).toBeNull();
    });
  });

  test("保存されているトークンが壊れていたら、理由を出す", async () => {
    await withConnections(async ({ manager, dir }) => {
      const tokenDir = join(dir, "data", "connections");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(join(tokenDir, "github.json"), "{ not json", "utf8");

      expect(manager.view().providers[0]?.detail).not.toBeNull();
      expect(manager.env()).toEqual({});
      expect(await rejectionOf(manager.wait("github", signal()))).toMatch(/could not be read/);
    });
  });

  test("知らない接続 id は失敗する", async () => {
    await withConnections(async ({ manager }) => {
      expect(() => manager.provider("unknown")).toThrow(ConnectionNotFound);
    });
  });
});

describe("Application ID（Discord）", () => {
  /** bot プロバイダ（Discord）を足して走らせる。 */
  function withBotConnections(run: (context: Context) => Promise<void>): Promise<void> {
    return withConnections(run, (server) => [fakeBotProvider(server)]);
  }

  test("保存した Application ID から招待リンクを組み立てる", async () => {
    await withBotConnections(async ({ manager, settings, server }) => {
      settings.setConnectionClientId("discord", "app-1");

      const provider = manager.view().providers.find((entry) => entry.id === "discord");
      const expected = new URL(`${server.origin}/authorize`);
      expected.searchParams.set("client_id", "app-1");
      expected.searchParams.set("scope", "bot");
      expected.searchParams.set("permissions", "68608");

      expect(provider?.needsClientId).toBe(true);
      expect(provider?.clientId).toBe("app-1");
      expect(provider?.inviteUrl).toBe(expected.toString());
    });
  });

  test("Application ID を変えても、保存済みのトークンは残る", async () => {
    await withBotConnections(async ({ manager, server }) => {
      await manager.setToken("discord", server.botToken);
      manager.setClientId("discord", "app-2");

      expect(manager.token("discord")).toBe(server.botToken);
      expect(manager.view().providers.find((entry) => entry.id === "discord")?.clientId).toBe("app-2");
    });
  });
});

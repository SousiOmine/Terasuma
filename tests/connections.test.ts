import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnections, type ConnectionsManager } from "../src/server/connections/manager";
import type { ConnectionProvider } from "../src/server/connections/providers";
import { createSettingsStore, type SettingsStore } from "../src/server/data/settings";
import { ConnectionNotFound, ConnectionNotConfigured } from "../src/server/errors";
import { withTempDir } from "./harness";
import {
  fakeBotProvider,
  fakeProvider,
  startFakeDeviceFlowServer,
  type FakeDeviceFlowServer,
} from "./fixtures/device-flow-server";

/**
 * アプリの接続（Device Flow）。
 * 認可ページを開くブラウザは介在させず、偽の認可サーバーの approve / deny で進める。
 */

type Context = {
  manager: ConnectionsManager;
  settings: SettingsStore;
  dir: string;
  server: FakeDeviceFlowServer;
};

/** 偽の認可サーバーと、一時ディレクトリの設定・トークン置き場を用意する。 */
async function withConnections(
  run: (context: Context) => Promise<void>,
  extraProviders: (server: FakeDeviceFlowServer) => ConnectionProvider[] = () => [],
): Promise<void> {
  const server = startFakeDeviceFlowServer();
  try {
    await withTempDir("terasuma-connections-", async (dir) => {
      const settings = createSettingsStore(join(dir, "config.json"));
      settings.setConnectionClientId("github", "client-1");

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
  test("Client ID が無ければ認可を始められない", async () => {
    await withConnections(async ({ manager, settings }) => {
      settings.setConnectionClientId("github", null);

      await expect(manager.start("github")).rejects.toBeInstanceOf(ConnectionNotConfigured);
    });
  });

  test("デバイスコードを要求し、承認されるとトークンを保存して待ちを解く", async () => {
    await withConnections(async ({ manager, dir, server }) => {
      const flow = await manager.start("github");
      expect(flow?.userCode).toBe("ABCD-1234");
      expect(flow?.verificationUri).toBe(`${server.origin}/device`);

      // 要求には Client ID と scope が載る。
      expect(server.deviceRequests[0]?.get("client_id")).toBe("client-1");
      expect(server.deviceRequests[0]?.get("scope")).toBe("repo read:user");

      const waiting = manager.wait("github", signal());
      server.approve();

      expect(await waiting).toContain("@octocat");
      expect(server.tokenRequests.at(-1)?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");

      // コンピュータへ渡す値と、画面に出すアカウント。
      expect(manager.env()).toEqual({ GH_TOKEN: "access-1", GITHUB_TOKEN: "access-1" });
      expect(manager.view().providers[0]).toMatchObject({ account: "octocat", flow: null, detail: null });

      // トークンは本人だけが読める権限で保存する。
      const tokenPath = join(dir, "data", "connections", "github.json");
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

      // 接続済みなら、認可を始め直さない。
      expect(await manager.start("github")).toBeNull();
    });
  });

  test("接続済みなら、待たずに使い方を返す", async () => {
    await withConnections(async ({ manager, server }) => {
      server.approve();
      await manager.wait("github", signal());

      const again = await manager.wait("github", signal());
      expect(again).toContain("is connected");
      expect(again).toContain("$GH_TOKEN");
      expect(server.deviceRequests).toHaveLength(1);
    });
  });

  test("中止すると、待っているツールは失敗する", async () => {
    await withConnections(async ({ manager }) => {
      await manager.start("github");

      const waiting = manager.wait("github", signal());
      const rejected = rejectionOf(waiting);

      manager.cancel("github");
      expect(await rejected).toMatch(/cancelled/);

      expect(manager.view().providers[0]?.flow).toBeNull();
    });
  });

  test("ターンが止まると、待ちは外れる", async () => {
    await withConnections(async ({ manager }) => {
      await manager.start("github");

      const controller = new AbortController();
      const waiting = manager.wait("github", controller.signal);
      const rejected = rejectionOf(waiting);

      controller.abort();
      expect(await rejected).toMatch(/turn ended/);
    });
  });

  test("拒否されると、待ちはその理由で失敗する", async () => {
    await withConnections(async ({ manager, server }) => {
      server.deny();

      const waiting = manager.wait("github", signal());
      expect(await rejectionOf(waiting)).toMatch(/denied/);
    });
  });

  test("切断すると、保存した認可も消える", async () => {
    await withConnections(async ({ manager, dir, server }) => {
      server.approve();
      await manager.wait("github", signal());

      const tokenPath = join(dir, "data", "connections", "github.json");
      expect(existsSync(tokenPath)).toBe(true);

      manager.disconnect("github");

      expect(existsSync(tokenPath)).toBe(false);
      expect(manager.env()).toEqual({});
      expect(manager.view().providers[0]?.account).toBeNull();
    });
  });

  test("保存されている認可が壊れていたら、理由を出す", async () => {
    await withConnections(async ({ manager, dir }) => {
      const tokenDir = join(dir, "data", "connections");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(join(tokenDir, "github.json"), "{ not json", "utf8");

      expect(manager.view().providers[0]?.detail).not.toBeNull();
      expect(manager.env()).toEqual({});
      expect(await rejectionOf(manager.wait("github", signal()))).toMatch(/could not be read/);
    });
  });

  test("Client ID を変えると、進行中の認可は止まる", async () => {
    await withConnections(async ({ manager, settings, server }) => {
      await manager.start("github");

      const waiting = manager.wait("github", signal());
      const rejected = rejectionOf(waiting);

      manager.setClientId("github", "client-2");
      expect(await rejected).toMatch(/cancelled/);

      expect(settings.read().connections["github"]).toEqual({ clientId: "client-2" });
      // 止めたので、古い Client ID への問い合わせは残らない。
      expect(manager.view().providers[0]?.flow).toBeNull();
      expect(server.deviceRequests).toHaveLength(1);
    });
  });

  test("同じ Client ID を保存しても、進行中の認可は続く", async () => {
    await withConnections(async ({ manager, server }) => {
      await manager.start("github");

      const waiting = manager.wait("github", signal());
      manager.setClientId("github", "client-1");
      server.approve();

      expect(await waiting).toContain("@octocat");
      expect(server.deviceRequests).toHaveLength(1);
    });
  });

  test("同じプロバイダの認可を重ねて始めても、コードは 1 つ", async () => {
    await withConnections(async ({ manager, server }) => {
      const [first, second] = await Promise.all([manager.start("github"), manager.start("github")]);

      expect(first?.userCode).toBe("ABCD-1234");
      expect(second?.userCode).toBe("ABCD-1234");
      expect(server.deviceRequests).toHaveLength(1);
    });
  });

  test("知らない接続 id は失敗する", async () => {
    await withConnections(async ({ manager }) => {
      expect(() => manager.provider("unknown")).toThrow(ConnectionNotFound);
    });
  });
});

describe("Bot トークンの接続", () => {
  /** bot プロバイダ（Discord）を足して走らせる。 */
  function withBotConnections(run: (context: Context) => Promise<void>): Promise<void> {
    return withConnections(run, (server) => [fakeBotProvider(server)]);
  }

  test("保存すると、接続済みになり環境変数に載る", async () => {
    await withBotConnections(async ({ manager, dir, server }) => {
      const view = await manager.setToken("discord", server.botToken);
      const provider = view.providers.find((entry) => entry.id === "discord");

      expect(provider).toMatchObject({
        kind: "bot",
        connected: true,
        account: server.botAccount,
        clientId: null,
        flow: null,
        detail: null,
      });
      expect(provider?.permissions).toEqual(["View Channel", "Send Messages"]);
      expect(manager.token("discord")).toBe(server.botToken);
      expect(manager.env()).toEqual({ DISCORD_BOT_TOKEN: server.botToken });

      // トークンは本人だけが読める権限で保存する。
      const tokenPath = join(dir, "data", "connections", "discord.json");
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

      // 接続済みなら、認可を始め直さない。
      expect(await manager.start("discord")).toBeNull();

      const connected = await manager.wait("discord", signal());
      expect(connected).toContain(`@${server.botAccount}`);
      expect(connected).toContain("$DISCORD_BOT_TOKEN");
    });
  });

  test("受け付けられないトークンは保存しない", async () => {
    await withBotConnections(async ({ manager, dir }) => {
      expect(await rejectionOf(manager.setToken("discord", "wrong"))).toMatch(/did not accept the token/);

      expect(manager.token("discord")).toBeNull();
      expect(existsSync(join(dir, "data", "connections", "discord.json"))).toBe(false);
    });
  });

  test("トークンが無ければ、認可を始めずに設定を促す", async () => {
    await withBotConnections(async ({ manager }) => {
      expect(await rejectionOf(manager.wait("discord", signal()))).toMatch(/Settings > Connections/);
      expect(await rejectionOf(manager.start("discord"))).toContain("Bot トークン");
      expect(() => manager.cancel("discord")).not.toThrow();
    });
  });

  test("Application ID から招待リンクを組み立てる", async () => {
    await withBotConnections(async ({ manager, settings, server }) => {
      settings.setConnectionClientId("discord", "app-1");

      const provider = manager.view().providers.find((entry) => entry.id === "discord");
      const expected = new URL(`${server.origin}/authorize`);
      expected.searchParams.set("client_id", "app-1");
      expected.searchParams.set("scope", "bot");
      expected.searchParams.set("permissions", "68608");

      expect(provider?.inviteUrl).toBe(expected.toString());
    });
  });

  test("Device Flow のアプリには、トークンを保存できない", async () => {
    await withBotConnections(async ({ manager }) => {
      expect(await rejectionOf(manager.setToken("github", "token"))).toMatch(/does not use a pasted token/);
    });
  });
});

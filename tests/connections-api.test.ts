import { describe, expect, test } from "bun:test";
import { createConnections } from "../src/server/connections/manager";
import type { ConnectionProvider } from "../src/server/connections/providers";
import type { ConnectionsView } from "../src/shared/api/settings";
import { type ServerHarness, withServer } from "./harness";
import {
  fakeBotProvider,
  fakeProvider,
  startFakeConnectionServer,
  type FakeConnectionServer,
} from "./fixtures/connection-server";

/**
 * アプリの接続の HTTP API。
 * トークンは偽の API サーバーで検証する。
 */

type Run = (harness: ServerHarness, server: FakeConnectionServer) => Promise<void>;

/** 偽の接続先を宛先にした接続マネージャで、サーバを起こす。 */
async function withConnectionServer(
  run: Run,
  extraProviders: (server: FakeConnectionServer) => ConnectionProvider[] = () => [],
): Promise<void> {
  const server = startFakeConnectionServer();
  try {
    await withServer((harness) => run(harness, server), {
      connections: ({ settings, dir }) =>
        createConnections({
          settings,
          dataDir: dir,
          providers: [fakeProvider(server), ...extraProviders(server)],
        }),
    });
  } finally {
    await server.server.stop(true);
  }
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** 一覧を読む。 */
async function connections(harness: ServerHarness): Promise<ConnectionsView> {
  const response = await harness.request("/api/connections");
  expect(response.status).toBe(200);
  return (await response.json()) as ConnectionsView;
}

describe("接続の API", () => {
  test("一覧は未設定の状態を返す", async () => {
    await withConnectionServer(async (harness) => {
      const view = await connections(harness);

      expect(view.providers).toHaveLength(1);
      expect(view.providers[0]).toMatchObject({
        id: "github",
        name: "GitHub",
        clientId: null,
        needsClientId: false,
        account: null,
        detail: null,
      });
      expect(view.providers[0]?.env).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
      expect(view.providers[0]?.token.label).toBe("Personal Access Token");
    });
  });

  test("トークンを保存すると、接続済みとして返す", async () => {
    await withConnectionServer(async (harness, server) => {
      const response = await harness.request(
        "/api/connections/github/token",
        jsonRequest("PUT", { token: `  ${server.accessToken}  ` }),
      );

      expect(response.status).toBe(200);
      const provider = ((await response.json()) as ConnectionsView).providers[0];
      expect(provider).toMatchObject({
        connected: true,
        account: server.account,
      });
    });
  });

  test("受け付けられないトークンは 400", async () => {
    await withConnectionServer(async (harness) => {
      const response = await harness.request("/api/connections/github/token", jsonRequest("PUT", { token: "wrong" }));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("空のトークンは 400", async () => {
    await withConnectionServer(async (harness) => {
      const response = await harness.request("/api/connections/github/token", jsonRequest("PUT", { token: "  " }));

      expect(response.status).toBe(400);
    });
  });

  test("保存したトークンを切断すると消える", async () => {
    await withConnectionServer(async (harness, server) => {
      await harness.request("/api/connections/github/token", jsonRequest("PUT", { token: server.accessToken }));

      const removed = await harness.request("/api/connections/github", { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as ConnectionsView).providers[0]?.account).toBeNull();
    });
  });

  test("知らない接続は 404", async () => {
    await withConnectionServer(async (harness) => {
      const response = await harness.request("/api/connections/unknown/token", jsonRequest("PUT", { token: "x" }));

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("connection_not_found");
    });
  });

  test("Application ID を保存すると、設定ファイルにも書かれる", async () => {
    await withConnectionServer(
      async (harness) => {
        const response = await harness.request(
          "/api/connections/discord",
          jsonRequest("PUT", { clientId: "  app-1  " }),
        );

        expect(response.status).toBe(200);
        const provider = ((await response.json()) as ConnectionsView).providers.find((entry) => entry.id === "discord");
        expect(provider?.clientId).toBe("app-1");
        expect(provider?.needsClientId).toBe(true);
        expect(harness.file().connections).toEqual({ discord: { clientId: "app-1" } });
      },
      (server) => [fakeBotProvider(server)],
    );
  });

  test("空の Application ID は設定ごと消す", async () => {
    await withConnectionServer(
      async (harness) => {
        await harness.request("/api/connections/discord", jsonRequest("PUT", { clientId: "app-1" }));

        const response = await harness.request("/api/connections/discord", jsonRequest("PUT", { clientId: "  " }));

        expect(response.status).toBe(200);
        const provider = ((await response.json()) as ConnectionsView).providers.find((entry) => entry.id === "discord");
        expect(provider?.clientId).toBeNull();
        expect(harness.file().connections).toBeUndefined();
      },
      (server) => [fakeBotProvider(server)],
    );
  });

  test("Application ID が文字列でも null でもなければ 400", async () => {
    await withConnectionServer(
      async (harness) => {
        const response = await harness.request("/api/connections/discord", jsonRequest("PUT", { clientId: 42 }));

        expect(response.status).toBe(400);
        expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
      },
      (server) => [fakeBotProvider(server)],
    );
  });

  test("Application ID から招待リンクを組み立てる", async () => {
    await withConnectionServer(
      async (harness, server) => {
        await harness.request("/api/connections/discord", jsonRequest("PUT", { clientId: "app-1" }));

        const provider = (await connections(harness)).providers.find((entry) => entry.id === "discord");
        const expected = new URL(`${server.origin}/authorize`);
        expected.searchParams.set("client_id", "app-1");
        expected.searchParams.set("scope", "bot");
        expected.searchParams.set("permissions", "68608");

        expect(provider?.inviteUrl).toBe(expected.toString());
      },
      (server) => [fakeBotProvider(server)],
    );
  });

  test("接続の待ちを中止できる", async () => {
    await withConnectionServer(async (harness) => {
      const response = await harness.request("/api/connections/github/wait", { method: "DELETE" });

      expect(response.status).toBe(200);
      expect(((await response.json()) as ConnectionsView).providers[0]?.connected).toBe(false);
    });
  });

  test("Discord のトークンを保存すると、接続済みとして返す", async () => {
    await withConnectionServer(
      async (harness, server) => {
        const response = await harness.request(
          "/api/connections/discord/token",
          jsonRequest("PUT", { token: `  ${server.botToken}  ` }),
        );

        expect(response.status).toBe(200);
        const provider = ((await response.json()) as ConnectionsView).providers.find((entry) => entry.id === "discord");
        expect(provider).toMatchObject({
          connected: true,
          account: server.botAccount,
          clientId: null,
        });
      },
      (server) => [fakeBotProvider(server)],
    );
  });

  test("受け付けられない Discord トークンは 400", async () => {
    await withConnectionServer(
      async (harness) => {
        const response = await harness.request(
          "/api/connections/discord/token",
          jsonRequest("PUT", { token: "wrong" }),
        );

        expect(response.status).toBe(400);
      },
      (server) => [fakeBotProvider(server)],
    );
  });
});

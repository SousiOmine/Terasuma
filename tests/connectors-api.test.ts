import { describe, expect, test } from "bun:test";
import { createConnectors } from "../src/server/connectors/manager";
import type { ConnectorsView } from "../src/shared/api/settings";
import { type ServerHarness, withServer } from "./harness";
import { fakeProvider, startFakeConnectorServer, type FakeConnectorServer } from "./fixtures/connector-server";

/**
 * コネクタの HTTP API。
 * トークンは偽の API サーバーで検証する。
 * Discord は Tera ごとの webhook なので、ここではなく tests/discord-api.test.ts が確かめる。
 */

type Run = (harness: ServerHarness, server: FakeConnectorServer) => Promise<void>;

/** 偽の接続先を宛先にしたコネクタマネージャで、サーバを起こす。 */
async function withConnectorServer(run: Run): Promise<void> {
  const server = startFakeConnectorServer();
  try {
    await withServer((harness) => run(harness, server), {
      connectors: ({ dir }) => createConnectors({ dataDir: dir, providers: [fakeProvider(server)] }),
    });
  } finally {
    await server.server.stop(true);
  }
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** 一覧を読む。 */
async function connectors(harness: ServerHarness): Promise<ConnectorsView> {
  const response = await harness.request("/api/connectors");
  expect(response.status).toBe(200);
  return (await response.json()) as ConnectorsView;
}

describe("コネクタの API", () => {
  test("一覧は未設定の状態を返す", async () => {
    await withConnectorServer(async (harness) => {
      const view = await connectors(harness);

      expect(view.providers).toHaveLength(1);
      expect(view.providers[0]).toMatchObject({
        id: "github",
        name: "GitHub",
        account: null,
        detail: null,
      });
      expect(view.providers[0]?.env).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
      expect(view.providers[0]?.token.label).toBe("Personal Access Token");
    });
  });

  test("トークンを保存すると、接続済みとして返す", async () => {
    await withConnectorServer(async (harness, server) => {
      const response = await harness.request(
        "/api/connectors/github/token",
        jsonRequest("PUT", { token: `  ${server.accessToken}  ` }),
      );

      expect(response.status).toBe(200);
      const provider = ((await response.json()) as ConnectorsView).providers[0];
      expect(provider).toMatchObject({
        connected: true,
        account: server.account,
      });
    });
  });

  test("受け付けられないトークンは 400", async () => {
    await withConnectorServer(async (harness) => {
      const response = await harness.request("/api/connectors/github/token", jsonRequest("PUT", { token: "wrong" }));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("空のトークンは 400", async () => {
    await withConnectorServer(async (harness) => {
      const response = await harness.request("/api/connectors/github/token", jsonRequest("PUT", { token: "  " }));

      expect(response.status).toBe(400);
    });
  });

  test("保存したトークンを切断すると消える", async () => {
    await withConnectorServer(async (harness, server) => {
      await harness.request("/api/connectors/github/token", jsonRequest("PUT", { token: server.accessToken }));

      const removed = await harness.request("/api/connectors/github", { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as ConnectorsView).providers[0]?.account).toBeNull();
    });
  });

  test("知らないコネクタは 404", async () => {
    await withConnectorServer(async (harness) => {
      const response = await harness.request("/api/connectors/unknown/token", jsonRequest("PUT", { token: "x" }));

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("connector_not_found");
    });
  });

  test("コネクタの待ちを中止できる", async () => {
    await withConnectorServer(async (harness) => {
      const response = await harness.request("/api/connectors/github/wait", { method: "DELETE" });

      expect(response.status).toBe(200);
      expect(((await response.json()) as ConnectorsView).providers[0]?.connected).toBe(false);
    });
  });
});

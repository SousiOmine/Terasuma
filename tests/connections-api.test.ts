import { describe, expect, test } from "bun:test";
import { createConnections } from "../src/server/connections/manager";
import type { DeviceFlowProvider } from "../src/server/connections/providers";
import type { ConnectionsView } from "../src/shared/types";
import { type ServerHarness, withServer } from "./harness";
import { fakeProvider, startFakeDeviceFlowServer, type FakeDeviceFlowServer } from "./fixtures/device-flow-server";

/**
 * アプリの接続の HTTP API。
 * 認可は偽の Device Flow サーバーへ向け、ブラウザの代わりに approve() で進める。
 */

type Run = (harness: ServerHarness, server: FakeDeviceFlowServer) => Promise<void>;

/** 偽の認可サーバーを宛先にした接続マネージャで、サーバを起こす。 */
async function withConnectionServer(
  run: Run,
  overrides: (server: FakeDeviceFlowServer) => Partial<DeviceFlowProvider> = () => ({}),
): Promise<void> {
  const server = startFakeDeviceFlowServer();
  try {
    await withServer((harness) => run(harness, server), {
      connections: ({ settings, dir }) =>
        createConnections({
          settings,
          dataDir: dir,
          providers: [{ ...fakeProvider(server), ...overrides(server) }],
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

/** 認可が終わって、アカウントが見えるようになるまで待つ。 */
async function waitForAccount(harness: ServerHarness): Promise<ConnectionsView> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const view = await connections(harness);
    if (view.providers[0]?.account !== null) return view;
    await Bun.sleep(10);
  }
  throw new Error("接続が終わりませんでした");
}

describe("接続の API", () => {
  test("一覧は Client ID 未設定の状態を返す", async () => {
    await withConnectionServer(async (harness) => {
      const view = await connections(harness);

      expect(view.providers).toHaveLength(1);
      expect(view.providers[0]).toMatchObject({
        id: "github",
        name: "GitHub",
        clientId: null,
        account: null,
        flow: null,
        detail: null,
      });
      expect(view.providers[0]?.env).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
    });
  });

  test("Client ID を保存すると、設定ファイルにも書かれる", async () => {
    await withConnectionServer(async (harness) => {
      const response = await harness.request(
        "/api/connections/github",
        jsonRequest("PUT", { clientId: "  client-1  " }),
      );

      expect(response.status).toBe(200);
      const view = (await response.json()) as ConnectionsView;
      expect(view.providers[0]?.clientId).toBe("client-1");
      expect(harness.file().connections).toEqual({ github: { clientId: "client-1" } });
    });
  });

  test("空の Client ID は設定ごと消す", async () => {
    await withConnectionServer(async (harness) => {
      await harness.request("/api/connections/github", jsonRequest("PUT", { clientId: "client-1" }));

      const response = await harness.request("/api/connections/github", jsonRequest("PUT", { clientId: "  " }));

      expect(response.status).toBe(200);
      expect(((await response.json()) as ConnectionsView).providers[0]?.clientId).toBeNull();
      expect(harness.file().connections).toBeUndefined();
    });
  });

  test("知らない接続は 404", async () => {
    await withConnectionServer(async (harness) => {
      const response = await harness.request("/api/connections/unknown", jsonRequest("PUT", { clientId: "x" }));

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("connection_not_found");
    });
  });

  test("Client ID が無ければ認可を始められない", async () => {
    await withConnectionServer(async (harness) => {
      const response = await harness.request("/api/connections/github/authorize", { method: "POST" });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("connection_not_configured");
    });
  });

  test("認可を始めるとコードが返り、承認すると接続済みになる", async () => {
    await withConnectionServer(async (harness, server) => {
      await harness.request("/api/connections/github", jsonRequest("PUT", { clientId: "client-1" }));

      const started = await harness.request("/api/connections/github/authorize", { method: "POST" });
      expect(started.status).toBe(200);

      const flow = ((await started.json()) as { flow: { userCode: string; verificationUri: string } }).flow;
      expect(flow.userCode).toBe("ABCD-1234");
      expect(flow.verificationUri).toBe(`${server.origin}/device`);

      server.approve();
      const view = await waitForAccount(harness);
      expect(view.providers[0]).toMatchObject({ account: "octocat", flow: null });

      const removed = await harness.request("/api/connections/github", { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as ConnectionsView).providers[0]?.account).toBeNull();
    });
  });

  test("認可を中止すると、進行中のフローが消える", async () => {
    await withConnectionServer(async (harness) => {
      await harness.request("/api/connections/github", jsonRequest("PUT", { clientId: "client-1" }));
      await harness.request("/api/connections/github/authorize", { method: "POST" });

      const response = await harness.request("/api/connections/github/flow", { method: "DELETE" });

      expect(response.status).toBe(200);
      expect(((await response.json()) as ConnectionsView).providers[0]?.flow).toBeNull();
    });
  });

  test("認可を始められないときは 502 と理由を返す", async () => {
    await withConnectionServer(
      async (harness) => {
        await harness.request("/api/connections/github", jsonRequest("PUT", { clientId: "client-1" }));

        const response = await harness.request("/api/connections/github/authorize", { method: "POST" });

        expect(response.status).toBe(502);
        const body = (await response.json()) as { code: string; detail: string };
        expect(body.code).toBe("connection_authorization_failed");
        expect(body.detail).toContain("Device Flow");
      },
      (server) => ({ deviceCodeUrl: `${server.origin}/html-error` }),
    );
  });

  test("Client ID が文字列でも null でもなければ 400", async () => {
    await withConnectionServer(async (harness) => {
      const response = await harness.request("/api/connections/github", jsonRequest("PUT", { clientId: 42 }));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });
});

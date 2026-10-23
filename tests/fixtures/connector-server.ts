import type { Server } from "bun";
import type { ConnectorProvider } from "../../src/server/connectors/providers";

/**
 * テストで使う接続先の API サーバー。
 *
 * GitHub の `/api/*` を真似る。
 * トークンの検証（アカウントの読み取り）と、app_request の応答だけを持つ。
 */
export type FakeConnectorServer = {
  server: Server<undefined>;
  /** サーバーの origin。プロバイダ定義の URL を組み立てる。 */
  readonly origin: string;
  /** GitHub のトークン。 */
  readonly accessToken: string;
  /** GitHub のアカウント名。 */
  readonly account: string;
};

export function startFakeConnectorServer(): FakeConnectorServer {
  let origin = "";
  const accessToken = "access-1";
  const account = "octocat";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

      const authorized = request.headers.get("authorization") === `Bearer ${accessToken}`;
      if (!authorized) return new Response("unauthorized", { status: 401 });

      if (url.pathname === "/api/user") return Response.json({ login: account });
      if (url.pathname === "/api/repos/octocat/hello") return Response.json({ full_name: "octocat/hello" });
      if (url.pathname === "/api/error") return Response.json({ message: "boom" }, { status: 500 });
      return new Response("not found", { status: 404 });
    },
  });

  origin = server.url.origin;

  return {
    server,
    get origin() {
      return origin;
    },
    accessToken,
    account,
  };
}

/** テスト用の GitHub プロバイダ。宛先だけを偽サーバーへ向ける。 */
export function fakeProvider(server: FakeConnectorServer): ConnectorProvider {
  return {
    id: "github",
    name: "GitHub",
    description: "test app",
    setupUrl: `${server.origin}/setup`,
    token: {
      label: "Personal Access Token",
      description: "test token",
      placeholder: "ghp_...",
    },
    permissions: ["repo", "read:user"],
    env: ["GH_TOKEN", "GITHUB_TOKEN"],
    usage: "For the API, use app_request (for example GET /user).",
    api: {
      baseUrl: `${server.origin}/api`,
      headers: { Accept: "application/json" },
      account: { path: "/user", field: "login" },
    },
  };
}

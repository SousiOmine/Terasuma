import type { Server } from "bun";
import type { BotTokenProvider, DeviceFlowProvider } from "../../src/server/connections/providers";

/**
 * テストで使う Device Flow の認可サーバー。
 *
 * デバイスコードの要求・トークンの問い合わせ・アカウントの取得だけを真似る。
 * 認可ページそのものはブラウザの役目なので持たない（テストは approve() で押したことにする）。
 */
export type FakeDeviceFlowServer = {
  server: Server<undefined>;
  /** サーバーの origin。プロバイダ定義の URL を組み立てる。 */
  readonly origin: string;
  /** デバイスコードの要求（送られた値）。 */
  deviceRequests: URLSearchParams[];
  /** トークンの問い合わせ（送られた値）。 */
  tokenRequests: URLSearchParams[];
  /** 次の問い合わせからトークンを返す。 */
  approve(): void;
  /** 次の問い合わせから拒否を返す。 */
  deny(): void;
  /** 発行するアクセストークン。 */
  readonly accessToken: string;
  /** アカウントの名前。 */
  readonly account: string;
  /** bot プロバイダが使うトークン。 */
  readonly botToken: string;
  /** bot のアカウント名。 */
  readonly botAccount: string;
};

export function startFakeDeviceFlowServer(): FakeDeviceFlowServer {
  let origin = "";
  let approved = false;
  let denied = false;
  const deviceRequests: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const accessToken = "access-1";
  const account = "octocat";
  const botToken = "bot-token-1";
  const botAccount = "terasuma-bot";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/device/code" && request.method === "POST") {
        const params = new URLSearchParams(await request.text());
        deviceRequests.push(params);

        return Response.json({
          device_code: "device-1",
          user_code: "ABCD-1234",
          verification_uri: `${origin}/device`,
          // テストを待たせないよう、間隔は 0 秒にする（実在のサーバーは 5 秒以上）。
          expires_in: 5,
          interval: 0,
        });
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const params = new URLSearchParams(await request.text());
        tokenRequests.push(params);

        if (denied) {
          return Response.json({ error: "access_denied", error_description: "The user denied the request" });
        }
        if (approved) {
          return Response.json({ access_token: accessToken, token_type: "bearer", scope: "repo" });
        }
        return Response.json({ error: "authorization_pending" });
      }

      if (url.pathname === "/html-error" && request.method === "POST") {
        // Device Flow を有効にしていないアプリのように、JSON ではない応答を返す。
        return new Response("<html><body>Not Found</body></html>", {
          status: 404,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.pathname.startsWith("/api/")) {
        const authorized = request.headers.get("authorization") === `Bearer ${accessToken}`;
        if (!authorized) return new Response("unauthorized", { status: 401 });

        if (url.pathname === "/api/user") return Response.json({ login: account });
        if (url.pathname === "/api/repos/octocat/hello") return Response.json({ full_name: "octocat/hello" });
        if (url.pathname === "/api/error") return Response.json({ message: "boom" }, { status: 500 });
        return new Response("not found", { status: 404 });
      }

      // bot プロバイダ。Authorization は Bearer ではなく `Bot <token>` を要求する。
      if (url.pathname.startsWith("/bot/")) {
        const authorized = request.headers.get("authorization") === `Bot ${botToken}`;
        if (!authorized) return new Response("unauthorized", { status: 401 });

        if (url.pathname === "/bot/user") return Response.json({ username: botAccount });
        if (url.pathname === "/bot/channels/123/messages") {
          if (request.method !== "POST") return Response.json([{ id: "1", content: "hello" }]);

          const body = (await request.json()) as { content?: unknown };
          return Response.json({ id: "999", content: typeof body.content === "string" ? body.content : "" });
        }
        return new Response("not found", { status: 404 });
      }

      return new Response("not found", { status: 404 });
    },
  });

  origin = server.url.origin;

  return {
    server,
    get origin() {
      return origin;
    },
    deviceRequests,
    tokenRequests,
    approve() {
      approved = true;
      denied = false;
    },
    deny() {
      denied = true;
      approved = false;
    },
    accessToken,
    account,
    botToken,
    botAccount,
  };
}

/** テスト用のプロバイダ定義。宛先だけを偽サーバーへ向ける。 */
export function fakeProvider(server: FakeDeviceFlowServer): DeviceFlowProvider {
  return {
    kind: "device",
    id: "github",
    name: "GitHub",
    description: "test app",
    setupUrl: `${server.origin}/setup`,
    deviceCodeUrl: `${server.origin}/device/code`,
    tokenUrl: `${server.origin}/token`,
    scopes: ["repo", "read:user"],
    env: ["GH_TOKEN", "GITHUB_TOKEN"],
    usage: "For the API, use app_request (for example GET /user).",
    api: {
      baseUrl: `${server.origin}/api`,
      headers: { Accept: "application/json" },
      account: { path: "/user", field: "login" },
    },
  };
}

/** テスト用の bot プロバイダ。トークンを貼る方式（Discord）を真似る。 */
export function fakeBotProvider(server: FakeDeviceFlowServer): BotTokenProvider {
  return {
    kind: "bot",
    id: "discord",
    name: "Discord",
    description: "test bot",
    setupUrl: `${server.origin}/setup-bot`,
    permissions: ["View Channel", "Send Messages"],
    env: ["DISCORD_BOT_TOKEN"],
    usage: 'For the API, use app_request (for example POST /channels/123/messages with {"content": "..."}).',
    invite: {
      authorizeUrl: `${server.origin}/authorize`,
      scope: "bot",
      permissions: "68608",
    },
    api: {
      baseUrl: `${server.origin}/bot`,
      headers: { Accept: "application/json" },
      account: { path: "/user", field: "username" },
      authorization: (token) => `Bot ${token}`,
    },
  };
}

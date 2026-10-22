import type { Server } from "bun";
import type { ConnectionProvider } from "../../src/server/connections/providers";

/**
 * テストで使う接続先の API サーバー。
 *
 * GitHub の `/api/*` と Discord の `/bot/*` を真似る。
 * トークンの検証（アカウントの読み取り）と、app_request の応答だけを持つ。
 */
export type FakeConnectionServer = {
  server: Server<undefined>;
  /** サーバーの origin。プロバイダ定義の URL を組み立てる。 */
  readonly origin: string;
  /** GitHub のトークン。 */
  readonly accessToken: string;
  /** GitHub のアカウント名。 */
  readonly account: string;
  /** Discord の bot トークン。 */
  readonly botToken: string;
  /** Discord のアカウント名。 */
  readonly botAccount: string;
};

export function startFakeConnectionServer(): FakeConnectionServer {
  let origin = "";
  const accessToken = "access-1";
  const account = "octocat";
  const botToken = "bot-token-1";
  const botAccount = "terasuma-bot";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

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
    accessToken,
    account,
    botToken,
    botAccount,
  };
}

/** テスト用の GitHub プロバイダ。宛先だけを偽サーバーへ向ける。 */
export function fakeProvider(server: FakeConnectionServer): ConnectionProvider {
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

/** テスト用の Discord プロバイダ。Invite リンクの組み立ても確かめられるようにする。 */
export function fakeBotProvider(server: FakeConnectionServer): ConnectionProvider {
  return {
    id: "discord",
    name: "Discord",
    description: "test bot",
    setupUrl: `${server.origin}/setup-bot`,
    token: {
      label: "Bot トークン",
      description: "test token",
      placeholder: "Bot トークン",
    },
    permissions: ["View Channel", "Send Messages", "Read Message History"],
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

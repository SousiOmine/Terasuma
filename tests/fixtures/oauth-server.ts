import { createHash } from "node:crypto";
import type { Server } from "bun";

/**
 * テストで使う認可サーバー。認可サーバーのふるまいを最小限だけ真似る。
 *
 * 探索（RFC 9728 / 8414）・動的クライアント登録（RFC 7591）・PKCE の検証・トークンの発行だけを行い、
 * ブラウザは介在しない。MCP サーバーを載せるときは mcp に fetch ハンドラを渡す
 * （発行ずみのアクセストークンを持つ要求だけがそこへ届き、それ以外は 401 になる）。
 */
export type FakeOAuthServer = {
  server: Server<undefined>;
  /** 認可サーバーの issuer。MCP サーバーを載せた場合は、その入口も `${issuer}/mcp`。 */
  readonly issuer: string;
  /** 動的クライアント登録に来た内容。 */
  registrations: Record<string, unknown>[];
  /** トークンの要求。 */
  tokenRequests: URLSearchParams[];
  /** 認可画面で「許可」を押したことにして、認可コードを発行する。 */
  approve(authorizationUrl: URL): string;
};

/** 認可コードを受け取る URL。テストでは実際には待ち受けない。 */
export const FAKE_REDIRECT_URL = new URL("http://127.0.0.1:3000/api/mcp/oauth/callback");

export function startFakeOAuthServer(
  options: { mcp?: (request: Request) => Response | Promise<Response> } = {},
): FakeOAuthServer {
  let issuer = "";
  const registrations: Record<string, unknown>[] = [];
  const tokenRequests: URLSearchParams[] = [];
  /** 発行ずみの認可コード。code → 認可要求の内容。 */
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  /** 発行ずみのアクセストークン。載せた MCP サーバーへ通す印になる。 */
  const accessTokens = new Set<string>();
  let issued = 0;

  /** 保護リソースのメタデータの場所。401 の WWW-Authenticate で知らせる。 */
  const resourceMetadataUrl = () => `${issuer}/.well-known/oauth-protected-resource/mcp`;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer] });
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      if (url.pathname === "/register" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        registrations.push(body);
        return Response.json({ ...body, client_id: `client-${registrations.length}`, client_id_issued_at: 0 });
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const params = new URLSearchParams(await request.text());
        tokenRequests.push(params);

        if (params.get("grant_type") === "refresh_token") return issueToken();

        const code = params.get("code") ?? "";
        const stored = codes.get(code);
        if (stored === undefined) return errorResponse("invalid_grant", "知らない認可コードです");

        // PKCE の検証。挑戦値と検証子が対応していなければ認可は成立しない。
        const verifier = params.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (challenge !== stored.challenge) return errorResponse("invalid_grant", "PKCE が一致しません");
        if (params.get("redirect_uri") !== stored.redirectUri) {
          return errorResponse("invalid_grant", "redirect_uri が一致しません");
        }

        return issueToken();
      }

      if (url.pathname === "/mcp" && options.mcp !== undefined) {
        const token = bearerToken(request);
        if (token === null || !accessTokens.has(token)) {
          return new Response("unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl()}"` },
          });
        }
        return options.mcp(request);
      }

      return new Response("not found", { status: 404 });
    },
  });

  issuer = `http://127.0.0.1:${server.port}`;

  /** アクセストークンを 1 つ発行する。更新のときも新しい値を出す。 */
  function issueToken(): Response {
    issued += 1;
    const accessToken = `access-${issued}`;
    accessTokens.add(accessToken);

    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3_600,
      refresh_token: `refresh-${issued}`,
    });
  }

  return {
    server,
    get issuer() {
      return issuer;
    },
    registrations,
    tokenRequests,
    approve(authorizationUrl) {
      const code = `code-${codes.size + 1}`;
      codes.set(code, {
        challenge: authorizationUrl.searchParams.get("code_challenge") ?? "",
        redirectUri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
      });
      return code;
    },
  };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function errorResponse(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400 });
}

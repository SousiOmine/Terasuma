import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileOAuthStorage,
  finishMcpAuthorization,
  serverIdFromState,
  startMcpAuthorization,
  type OAuthStorage,
} from "../src/server/mcp-oauth";

/** テストで使うサーバー id と URL。実際には接続しない。 */
const SERVER_ID = "remote";
const REDIRECT_URL = new URL("http://127.0.0.1:3000/api/mcp/oauth/callback");

/**
 * 認可サーバーのふるまいを最小限だけ真似る偽物。
 * 探索・動的クライアント登録・PKCE の検証・トークンの発行だけを行い、ブラウザは介在しない。
 */
function startFakeAuthorizationServer() {
  let issuer = "";
  const registrations: Record<string, unknown>[] = [];
  const tokenRequests: URLSearchParams[] = [];
  /** 発行済みの認可コード。code → 認可要求の内容。 */
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  let issued = 0;

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

        if (params.get("grant_type") === "refresh_token") {
          issued += 1;
          return Response.json({
            access_token: `access-${issued}`,
            token_type: "Bearer",
            expires_in: 3_600,
            refresh_token: `refresh-${issued}`,
          });
        }

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

        issued += 1;
        return Response.json({
          access_token: `access-${issued}`,
          token_type: "Bearer",
          expires_in: 3_600,
          refresh_token: `refresh-${issued}`,
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  issuer = `http://127.0.0.1:${server.port}`;

  return {
    server,
    get issuer() {
      return issuer;
    },
    registrations,
    tokenRequests,
    /** 認可画面で「許可」を押したことにして、認可コードを発行する。 */
    approve(authorizationUrl: URL): string {
      const code = `code-${codes.size + 1}`;
      codes.set(code, {
        challenge: authorizationUrl.searchParams.get("code_challenge") ?? "",
        redirectUri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
      });
      return code;
    },
  };
}

function errorResponse(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400 });
}

async function withStorage<T>(run: (storage: OAuthStorage, path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-oauth-"));
  const path = join(dir, "remote.json");
  try {
    return await run(createFileOAuthStorage(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MCP の OAuth", () => {
  test("認可を始めると、登録ずみのクライアントで PKCE 付きの URL が返る", async () => {
    const as = startFakeAuthorizationServer();
    try {
      await withStorage(async (storage) => {
        const result = await startMcpAuthorization({
          serverId: SERVER_ID,
          serverUrl: `${as.issuer}/mcp`,
          redirectUrl: REDIRECT_URL,
          storage,
        });

        expect(result.kind).toBe("redirect");
        if (result.kind !== "redirect") return;

        const url = new URL(result.url);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).not.toBeNull();
        expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URL.toString());
        expect(url.searchParams.get("client_id")).toBe("client-1");
        expect(serverIdFromState(url.searchParams.get("state") ?? "")).toBe(SERVER_ID);

        // 動的クライアント登録は 1 回だけ行われ、名前と戻り先が伝わっている。
        expect(as.registrations).toHaveLength(1);
        expect(as.registrations[0]?.["client_name"]).toBe("Terasuma");
        expect(as.registrations[0]?.["redirect_uris"]).toEqual([REDIRECT_URL.toString()]);
        expect(as.tokenRequests).toHaveLength(0);
      });
    } finally {
      await as.server.stop(true);
    }
  });

  test("コールバックで受け取ったコードをトークンに交換し、次は認可を求めない", async () => {
    const as = startFakeAuthorizationServer();
    try {
      await withStorage(async (storage) => {
        const material = { serverId: SERVER_ID, serverUrl: `${as.issuer}/mcp`, redirectUrl: REDIRECT_URL, storage };

        const started = await startMcpAuthorization(material);
        if (started.kind !== "redirect") throw new Error("認可が必要にならなかった");

        await finishMcpAuthorization({ ...material, code: as.approve(new URL(started.url)), iss: null });

        // 保存されたトークンで足りるので、2 回目は URL を開かなくてよい。
        expect(await startMcpAuthorization(material)).toEqual({ kind: "authorized" });
        expect(as.registrations).toHaveLength(1);
      });
    } finally {
      await as.server.stop(true);
    }
  });

  test("期限切れのトークンは、保存済みの更新トークンで更新する", async () => {
    const as = startFakeAuthorizationServer();
    try {
      await withStorage(async (storage) => {
        const material = { serverId: SERVER_ID, serverUrl: `${as.issuer}/mcp`, redirectUrl: REDIRECT_URL, storage };

        const started = await startMcpAuthorization(material);
        if (started.kind !== "redirect") throw new Error("認可が必要にならなかった");
        await finishMcpAuthorization({ ...material, code: as.approve(new URL(started.url)), iss: null });

        // 期限切れの状態を作る（更新トークンは残っている）。
        const stored = JSON.parse(storage.get(`tokens:${as.issuer}`) ?? "{}") as Record<string, unknown>;
        storage.set(
          `tokens:${as.issuer}`,
          JSON.stringify({ ...stored, expires_in: 0, expiresAt: Date.now() - 1_000 }),
        );

        expect(await startMcpAuthorization(material)).toEqual({ kind: "authorized" });
        expect(as.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");

        const refreshed = JSON.parse(storage.get(`tokens:${as.issuer}`) ?? "{}") as Record<string, unknown>;
        expect(refreshed["access_token"]).toBe("access-2");
      });
    } finally {
      await as.server.stop(true);
    }
  });

  test("コールバック先が変わったら、登録からやり直す", async () => {
    const as = startFakeAuthorizationServer();
    try {
      await withStorage(async (storage) => {
        const base = { serverId: SERVER_ID, serverUrl: `${as.issuer}/mcp`, storage };

        const first = await startMcpAuthorization({ ...base, redirectUrl: REDIRECT_URL });
        expect(first.kind).toBe("redirect");
        expect(as.registrations).toHaveLength(1);

        // 待ち受けポートが変わった状況。古い登録のまま認可へ進んではいけない。
        const moved = new URL("http://127.0.0.1:3100/api/mcp/oauth/callback");
        const second = await startMcpAuthorization({ ...base, redirectUrl: moved });

        expect(second.kind).toBe("redirect");
        expect(as.registrations).toHaveLength(2);
        expect(as.registrations[1]?.["redirect_uris"]).toEqual([moved.toString()]);
        if (second.kind === "redirect") {
          expect(new URL(second.url).searchParams.get("client_id")).toBe("client-2");
        }
      });
    } finally {
      await as.server.stop(true);
    }
  });

  test("state からサーバー id を取り出せる", () => {
    expect(serverIdFromState("terasuma.remote.abc")).toBe("remote");
    expect(serverIdFromState("other.remote.abc")).toBeNull();
    expect(serverIdFromState("terasuma.remote")).toBeNull();
  });
});

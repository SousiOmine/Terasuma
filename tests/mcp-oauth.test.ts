import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileOAuthStorage,
  finishMcpAuthorization,
  serverIdFromState,
  startMcpAuthorization,
  type OAuthStorage,
} from "../src/server/mcp/oauth";
import { FAKE_REDIRECT_URL, startFakeOAuthServer } from "./fixtures/oauth-server";

/** テストで使うサーバー id と URL。実際には接続しない。 */
const SERVER_ID = "remote";
const REDIRECT_URL = FAKE_REDIRECT_URL;

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
    const as = startFakeOAuthServer();
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
    const as = startFakeOAuthServer();
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
    const as = startFakeOAuthServer();
    try {
      await withStorage(async (storage) => {
        const material = { serverId: SERVER_ID, serverUrl: `${as.issuer}/mcp`, redirectUrl: REDIRECT_URL, storage };

        const started = await startMcpAuthorization(material);
        if (started.kind !== "redirect") throw new Error("認可が必要にならなかった");
        await finishMcpAuthorization({ ...material, code: as.approve(new URL(started.url)), iss: null });

        // 期限切れの状態を作る（更新トークンは残っている）。
        const stored = JSON.parse(storage.get(`tokens:${as.issuer}`) ?? "{}") as Record<string, unknown>;
        storage.set(`tokens:${as.issuer}`, JSON.stringify({ ...stored, expires_in: 0, expiresAt: Date.now() - 1_000 }));

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
    const as = startFakeOAuthServer();
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

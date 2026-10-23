import { describe, expect, test } from "bun:test";
import { createWebSearchManager } from "../src/server/websearch-manager";
import type { FetchLike } from "../src/server/websearch/index";
import { withTempSettings } from "./support";

/** Exa の検索応答を、渡した形で返す fetch。 */
function stubFetch(response: () => Response): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return response();
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SETTINGS = {
  webSearch: { default: "exa", providers: { exa: { apiKey: "exa-key" } } },
};

describe("検索マネージャ", () => {
  test("既定のプロバイダを、設定から組み立てる", async () => {
    await withTempSettings(SETTINGS, async (settings) => {
      const stub = stubFetch(() => jsonResponse({ results: [] }));
      const manager = createWebSearchManager({ settings, fetch: stub.fetch });

      expect(manager.provider()?.id).toBe("exa");
    });
  });

  test("保存前の確認は、注入した fetch で 1 件だけ検索する", async () => {
    await withTempSettings(SETTINGS, async (settings) => {
      const stub = stubFetch(() =>
        jsonResponse({ results: [{ title: "T", url: "https://example.test", text: "snippet" }] }),
      );
      const manager = createWebSearchManager({ settings, fetch: stub.fetch });

      expect(await manager.test({ id: "exa", apiKey: null })).toEqual({ ok: true, detail: null, results: 1 });
      expect(stub.calls[0]).toContain("api.exa.ai");
    });
  });

  test("画面から来たキーは、保存済みより優先する", async () => {
    await withTempSettings(SETTINGS, async (settings) => {
      const seen: string[] = [];
      const fetchImpl: FetchLike = async (_url, init) => {
        seen.push(new Headers(init.headers).get("x-api-key") ?? "");
        return jsonResponse({ results: [] });
      };
      const manager = createWebSearchManager({ settings, fetch: fetchImpl });

      await manager.test({ id: "exa", apiKey: "  typed-key  " });
      expect(seen).toEqual(["typed-key"]);
    });
  });

  test("API キーが無ければ、通信せずに理由を返す", async () => {
    await withTempSettings({ webSearch: { providers: {} } }, async (settings) => {
      const stub = stubFetch(() => jsonResponse({ results: [] }));
      const manager = createWebSearchManager({ settings, fetch: stub.fetch });

      expect(await manager.test({ id: "exa", apiKey: null })).toEqual({
        ok: false,
        detail: "API キーが設定されていません",
        results: 0,
      });
      expect(stub.calls).toEqual([]);
    });
  });

  test("知らないプロバイダは失敗にする", async () => {
    await withTempSettings(SETTINGS, async (settings) => {
      const manager = createWebSearchManager({ settings, fetch: stubFetch(() => jsonResponse({})).fetch });

      expect((await manager.test({ id: "unknown", apiKey: "k" })).ok).toBe(false);
    });
  });

  test("失敗の理由は、種類ごとの日本語の 1 文にする", async () => {
    await withTempSettings(SETTINGS, async (settings) => {
      const manager = createWebSearchManager({
        settings,
        fetch: stubFetch(() => jsonResponse({ error: { message: "bad key" } }, 401)).fetch,
      });

      const result = await manager.test({ id: "exa", apiKey: null });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("API キーが受け付けられませんでした");
      expect(result.detail).toContain("bad key");
    });
  });
});

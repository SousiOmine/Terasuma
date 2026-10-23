import { describe, expect, test } from "bun:test";
import type { FileSettings } from "../src/server/data/settings";
import type { WebSearchManager } from "../src/server/websearch-manager";
import type { WebSearchSettingsView, WebSearchTestView } from "../src/shared/types";
import { withServer } from "./harness";

/** 検索を持たない manager。API が設定をどう扱うかだけを確かめる。 */
function createManagerStub() {
  const calls: { id: string; apiKey: string | null }[] = [];
  let result: WebSearchTestView = { ok: true, detail: null, results: 3 };

  const manager: WebSearchManager = {
    provider: () => null,
    test: async (input) => {
      calls.push(input);
      return result;
    },
  };

  return {
    manager,
    calls,
    returnTestResult(next: WebSearchTestView) {
      result = next;
    },
  };
}

type Harness = {
  request(path: string, init?: RequestInit): Promise<Response>;
  settings(): Promise<WebSearchSettingsView>;
  file(): FileSettings;
};

/** 一時ディレクトリに本物の設定ファイルを置いて、Web 検索の API を HTTP 越しに確かめる。 */
async function withWebSearchServer<T>(
  initial: FileSettings,
  run: (harness: Harness, stub: ReturnType<typeof createManagerStub>) => Promise<T>,
): Promise<T> {
  const stub = createManagerStub();

  return withServer(
    ({ request, file }) =>
      run(
        {
          request,
          async settings() {
            const response = await request("/api/websearch");
            expect(response.status).toBe(200);
            return (await response.json()) as WebSearchSettingsView;
          },
          file,
        },
        stub,
      ),
    { settings: initial, webSearch: stub.manager },
  );
}

/** JSON を送る要求。 */
function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** 2 つのプロバイダを登録し、exa を既定にした設定。 */
const TWO_PROVIDERS: FileSettings = {
  webSearch: {
    default: "exa",
    providers: { exa: { apiKey: "exa-key" }, tavily: { apiKey: "tavily-key" } },
  },
};

describe("Web 検索の API", () => {
  test("一覧は既定と登録済みを返し、API キーは出さない", async () => {
    await withWebSearchServer(TWO_PROVIDERS, async (harness) => {
      const view = await harness.settings();

      expect(view.defaultId).toBe("exa");
      expect(view.providers).toEqual([
        { id: "exa", name: "Exa", supportsFetch: true, hasApiKey: true, isDefault: true },
        { id: "tavily", name: "Tavily", supportsFetch: true, hasApiKey: true, isDefault: false },
      ]);
      // 追加できるのは、まだ登録していないプロバイダだけ。
      expect(view.available.map((provider) => provider.id)).toEqual(["brave", "perplexity", "tinyfish"]);
      // API キーそのものは、どのプロバイダにも含めない。
      expect(JSON.stringify(view)).not.toContain("exa-key");
    });
  });

  test("追加すると設定ファイルに書かれ、既定が未設定ならそのプロバイダが既定になる", async () => {
    await withWebSearchServer({}, async (harness) => {
      const response = await harness.request(
        "/api/websearch/providers",
        jsonBody("POST", { id: "exa", apiKey: " exa-key " }),
      );

      expect(response.status).toBe(200);
      const view = (await response.json()) as WebSearchSettingsView;
      expect(view.defaultId).toBe("exa");
      expect(view.providers).toEqual([
        { id: "exa", name: "Exa", supportsFetch: true, hasApiKey: true, isDefault: true },
      ]);
      expect(harness.file().webSearch).toEqual({
        providers: { exa: { apiKey: "exa-key" } },
        default: "exa",
      });
    });
  });

  test("同じ id の追加は 409、壊れた入力は 400 で弾く", async () => {
    await withWebSearchServer(
      { webSearch: { default: "exa", providers: { exa: { apiKey: "exa-key" } } } },
      async (harness) => {
        const send = (body: unknown) => harness.request("/api/websearch/providers", jsonBody("POST", body));

        const duplicate = await send({ id: "exa", apiKey: "other" });
        expect(duplicate.status).toBe(409);
        expect(((await duplicate.json()) as { code: string }).code).toBe("web_search_exists");

        expect((await send({ id: "unknown", apiKey: "key" })).status).toBe(400);
        expect((await send({ id: "tavily", apiKey: "  " })).status).toBe(400);
        expect((await send({ id: "tavily" })).status).toBe(400);
      },
    );
  });

  test("変更は保存され、apiKey を省くと保存済みのキーを使う", async () => {
    await withWebSearchServer(
      { webSearch: { default: "exa", providers: { exa: { apiKey: "old-key" } } } },
      async (harness) => {
        const patch = (id: string, body: unknown) =>
          harness.request(`/api/websearch/providers/${id}`, jsonBody("PATCH", body));

        // apiKey が null なら、保存済みのキーをそのまま使う。
        const kept = await patch("exa", { id: "exa", apiKey: null });
        expect(kept.status).toBe(200);
        expect(harness.file().webSearch?.providers.exa).toEqual({ apiKey: "old-key" });

        const changed = await patch("exa", { id: "exa", apiKey: " new-key " });
        expect(changed.status).toBe(200);
        expect(harness.file().webSearch?.providers.exa).toEqual({ apiKey: "new-key" });

        // id は URL と揃っていなければならない。
        expect((await patch("exa", { id: "tavily", apiKey: "x" })).status).toBe(400);
        expect((await patch("missing", { id: "missing", apiKey: "x" })).status).toBe(404);
      },
    );
  });

  test("削除すると設定から消え、既定だった場合は既定も外れる", async () => {
    await withWebSearchServer(TWO_PROVIDERS, async (harness) => {
      const removed = await harness.request("/api/websearch/providers/exa", { method: "DELETE" });

      expect(removed.status).toBe(200);
      const view = (await removed.json()) as WebSearchSettingsView;
      expect(view.defaultId).toBeNull();
      expect(view.providers.map((provider) => provider.id)).toEqual(["tavily"]);
      expect(harness.file().webSearch).toEqual({ providers: { tavily: { apiKey: "tavily-key" } } });

      expect((await harness.request("/api/websearch/providers/exa", { method: "DELETE" })).status).toBe(404);
    });
  });

  test("既定を変えられる。未登録は 404、null で未設定に戻せる", async () => {
    await withWebSearchServer(TWO_PROVIDERS, async (harness) => {
      const put = (body: unknown) => harness.request("/api/websearch/default", jsonBody("PUT", body));

      const changed = await put({ id: "tavily" });
      expect(changed.status).toBe(200);
      expect(((await changed.json()) as WebSearchSettingsView).defaultId).toBe("tavily");
      expect(harness.file().webSearch?.default).toBe("tavily");

      expect((await put({ id: "missing" })).status).toBe(404);
      expect((await put({ id: 1 })).status).toBe(400);

      const unset = await put({ id: null });
      expect(unset.status).toBe(200);
      expect(((await unset.json()) as WebSearchSettingsView).defaultId).toBeNull();
      expect(harness.file().webSearch?.default).toBeUndefined();
    });
  });

  test("保存前の確認は設定を書かず、失敗しても 200 で理由を返す", async () => {
    await withWebSearchServer({}, async (harness, stub) => {
      const success = await harness.request(
        "/api/websearch/test",
        jsonBody("POST", { id: " exa ", apiKey: "exa-key" }),
      );
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ ok: true, detail: null, results: 3 });
      expect(stub.calls).toEqual([{ id: "exa", apiKey: "exa-key" }]);
      // 確かめるだけなので、設定ファイルには何も書かない。
      expect(harness.file().webSearch).toBeUndefined();

      stub.returnTestResult({ ok: false, detail: "API キーが受け付けられませんでした", results: 0 });
      const failed = await harness.request("/api/websearch/test", jsonBody("POST", { id: "exa", apiKey: "bad" }));
      expect(failed.status).toBe(200);
      expect(await failed.json()).toEqual({
        ok: false,
        detail: "API キーが受け付けられませんでした",
        results: 0,
      });

      const unknown = await harness.request("/api/websearch/test", jsonBody("POST", { id: "unknown", apiKey: "key" }));
      expect(unknown.status).toBe(400);
    });
  });
});

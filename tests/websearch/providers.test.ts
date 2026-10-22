import { describe, expect, test } from "bun:test";
import { WebSearchError } from "../../src/server/websearch/errors";
import { createSearchProvider, WEB_SEARCH_PROVIDER_IDS } from "../../src/server/websearch/providers/registry";
import type { FetchLike } from "../../src/server/websearch/types";

/**
 * プロバイダごとの、リクエストの組み立てと応答の読み取り。
 * 通信はせず、偽の fetch に「何を投げたか」を記録させる。
 */

type Call = { url: string; init: RequestInit };

/** 1 回分の応答を返す fetch。呼び出しを記録する。 */
function fakeFetch(respond: (call: Call) => Response): { calls: Call[]; fetch: FetchLike } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function headersOf(call: Call | undefined): Record<string, string> {
  if (call === undefined) throw new Error("fetch が呼ばれていません");
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  if (call === undefined) throw new Error("fetch が呼ばれていません");
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<WebSearchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WebSearchError) return error;
    throw error;
  }
  throw new Error("失敗するはずの呼び出しが成功しました");
}

describe("Exa", () => {
  test("検索は query と件数を送り、結果を正規化する", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        results: [
          {
            title: "Exa result",
            url: "https://example.com/a",
            publishedDate: "2026-01-02",
            text: "<p>Hello <b>world</b></p>",
          },
        ],
      }),
    );
    const provider = createSearchProvider({ id: "exa", apiKey: "k", fetch: fake.fetch });

    const response = await provider.search({ query: "hello", limit: 3 });

    const call = fake.calls[0];
    expect(call?.url).toBe("https://api.exa.ai/search");
    expect(call?.init.method).toBe("POST");
    expect(headersOf(call)["x-api-key"]).toBe("k");
    expect(bodyOf(call)).toMatchObject({ query: "hello", numResults: 3, type: "auto" });
    expect(response.results).toEqual([
      { title: "Exa result", url: "https://example.com/a", snippet: "Hello world", publishedAt: "2026-01-02" },
    ]);
  });

  test("取得は contents を使い、本文とタイトルを返す", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ results: [{ url: "https://example.com/a", title: "Page", text: "Body text" }] }),
    );
    const provider = createSearchProvider({ id: "exa", apiKey: "k", fetch: fake.fetch });

    const response = await provider.fetchPage({ url: "https://example.com/a" });

    expect(fake.calls[0]?.url).toBe("https://api.exa.ai/contents");
    expect(bodyOf(fake.calls[0])["urls"]).toEqual(["https://example.com/a"]);
    expect(response).toEqual({ url: "https://example.com/a", title: "Page", text: "Body text" });
  });
});

describe("Tavily", () => {
  test("検索は Bearer を送り、content を抜粋にする", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        results: [
          {
            title: "Tavily result",
            url: "https://example.com/t",
            content: "A short summary",
            published_date: "2026-02-03",
          },
        ],
      }),
    );
    const provider = createSearchProvider({ id: "tavily", apiKey: "tvly", fetch: fake.fetch });

    const response = await provider.search({ query: "q", limit: 4 });

    const call = fake.calls[0];
    expect(call?.url).toBe("https://api.tavily.com/search");
    expect(headersOf(call)["Authorization"]).toBe("Bearer tvly");
    expect(bodyOf(call)).toMatchObject({ query: "q", max_results: 4, search_depth: "basic" });
    expect(response.results[0]).toEqual({
      title: "Tavily result",
      url: "https://example.com/t",
      snippet: "A short summary",
      publishedAt: "2026-02-03",
    });
  });

  test("取得は extract を使い、raw_content を返す", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ results: [{ url: "https://example.com/t", raw_content: "# Page\nBody" }] }),
    );
    const provider = createSearchProvider({ id: "tavily", apiKey: "tvly", fetch: fake.fetch });

    const response = await provider.fetchPage({ url: "https://example.com/t" });

    expect(fake.calls[0]?.url).toBe("https://api.tavily.com/extract");
    expect(bodyOf(fake.calls[0])).toMatchObject({ urls: ["https://example.com/t"], format: "markdown" });
    expect(response.text).toBe("# Page\nBody");
  });

  test("extract の失敗は failed_results の理由で返す", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ results: [], failed_results: [{ url: "https://example.com/x", error: "blocked" }] }),
    );
    const provider = createSearchProvider({ id: "tavily", apiKey: "tvly", fetch: fake.fetch });

    const error = await rejection(provider.fetchPage({ url: "https://example.com/x" }));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("blocked");
  });
});

describe("Brave Search", () => {
  test("検索は web.results を読み、取得 API を持たない", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        web: {
          results: [
            {
              title: "Brave result",
              url: "https://example.com/b",
              description: "A <b>bold</b> snippet",
              page_age: "2026-03-04",
            },
          ],
        },
      }),
    );
    const provider = createSearchProvider({ id: "brave", apiKey: "brave-key", fetch: fake.fetch });

    const response = await provider.search({ query: "hello world", limit: 2 });

    const call = fake.calls[0];
    expect(call?.url).toStartWith("https://api.search.brave.com/res/v1/web/search?");
    expect(call?.url).toContain("q=hello+world");
    expect(call?.url).toContain("count=2");
    expect(headersOf(call)["X-Subscription-Token"]).toBe("brave-key");
    expect(provider.supportsFetch).toBe(false);
    expect(response.results[0]).toEqual({
      title: "Brave result",
      url: "https://example.com/b",
      snippet: "A bold snippet",
      publishedAt: "2026-03-04",
    });
  });

  test("取得は直接取得で HTML をテキストにする", async () => {
    const fake = fakeFetch(
      () =>
        new Response("<html><head><title>Direct</title></head><body><p>Hello</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const provider = createSearchProvider({ id: "brave", apiKey: "brave-key", fetch: fake.fetch });

    const response = await provider.fetchPage({ url: "https://example.com/page" });

    expect(fake.calls[0]?.url).toBe("https://example.com/page");
    expect(response.title).toBe("Direct");
    expect(response.text).toContain("Hello");
  });
});

describe("Perplexity", () => {
  test("検索は Search API を使い、snippet を読む", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        results: [
          { title: "Perplexity result", url: "https://example.com/p", snippet: "Answer text", date: "2026-04-05" },
        ],
      }),
    );
    const provider = createSearchProvider({ id: "perplexity", apiKey: "pplx", fetch: fake.fetch });

    const response = await provider.search({ query: "q", limit: 2 });

    const call = fake.calls[0];
    expect(call?.url).toBe("https://api.perplexity.ai/search");
    expect(headersOf(call)["Authorization"]).toBe("Bearer pplx");
    expect(bodyOf(call)).toMatchObject({ query: "q", max_results: 2 });
    expect(provider.supportsFetch).toBe(false);
    expect(response.results[0]?.snippet).toBe("Answer text");
  });
});

describe("TinyFish", () => {
  test("検索は X-API-Key を送り、件数を超えた結果を切る", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        results: [
          { title: "One", url: "https://example.com/1", snippet: "first" },
          { title: "Two", url: "https://example.com/2", snippet: "second" },
        ],
      }),
    );
    const provider = createSearchProvider({ id: "tinyfish", apiKey: "tf", fetch: fake.fetch });

    const response = await provider.search({ query: "q", limit: 1 });

    const call = fake.calls[0];
    expect(call?.url).toStartWith("https://api.search.tinyfish.ai?query=q");
    expect(headersOf(call)["X-API-Key"]).toBe("tf");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.title).toBe("One");
  });

  test("取得は markdown を要求し、errors を失敗として返す", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ results: [], errors: [{ url: "https://example.com/x", error: "target_unreachable" }] }),
    );
    const provider = createSearchProvider({ id: "tinyfish", apiKey: "tf", fetch: fake.fetch });

    const error = await rejection(provider.fetchPage({ url: "https://example.com/x" }));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("target_unreachable");
  });
});

describe("共通の振る舞い", () => {
  test("プロバイダの一覧は実装のあるものだけ", () => {
    expect(WEB_SEARCH_PROVIDER_IDS).toEqual(["exa", "tavily", "brave", "perplexity", "tinyfish"]);
  });

  test("件数は 1〜10 に収める", async () => {
    const fake = fakeFetch(() => jsonResponse({ results: [] }));
    const provider = createSearchProvider({ id: "perplexity", apiKey: "k", fetch: fake.fetch });

    await provider.search({ query: "q", limit: 999 });
    expect(bodyOf(fake.calls[0])["max_results"]).toBe(10);

    await provider.search({ query: "q", limit: -1 });
    expect(bodyOf(fake.calls[1])["max_results"]).toBe(1);
  });

  test("401 は auth、429 は rate_limit、500 は unavailable になる", async () => {
    const unauthorized = createSearchProvider({
      id: "perplexity",
      apiKey: "bad",
      fetch: fakeFetch(() => jsonResponse({ error: { message: "bad key" } }, 401)).fetch,
    });
    const limited = createSearchProvider({
      id: "perplexity",
      apiKey: "k",
      fetch: fakeFetch(() => jsonResponse({}, 429)).fetch,
    });
    const broken = createSearchProvider({
      id: "perplexity",
      apiKey: "k",
      fetch: fakeFetch(() => jsonResponse({}, 500)).fetch,
    });

    expect((await rejection(unauthorized.search({ query: "q", limit: 1 }))).code).toBe("auth");
    expect((await rejection(limited.search({ query: "q", limit: 1 }))).code).toBe("rate_limit");
    expect((await rejection(broken.search({ query: "q", limit: 1 }))).code).toBe("unavailable");
  });

  test("通信できないときは unavailable になる", async () => {
    const provider = createSearchProvider({
      id: "perplexity",
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const error = await rejection(provider.search({ query: "q", limit: 1 }));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("fetch failed");
  });

  test("本文は maxChars で切られ、切ったことが分かる", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ results: [{ url: "https://example.com", raw_content: "x".repeat(5_000) }] }),
    );
    const provider = createSearchProvider({ id: "tavily", apiKey: "k", fetch: fake.fetch });

    const response = await provider.fetchPage({ url: "https://example.com", maxChars: 1_000 });
    expect(response.text.length).toBeGreaterThan(1_000);
    expect(response.text).toContain("more characters");
  });
});

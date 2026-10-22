import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { createWebSearchToolset, createWebTools } from "../src/server/agent/tools/web";
import type { WebSearchManager } from "../src/server/websearch-manager";
import {
  WebSearchError,
  type FetchRequest,
  type SearchProvider,
  type SearchRequest,
} from "../src/server/websearch/index";
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../src/shared/tools";

/**
 * web_search / web_fetch の確認。
 * モデルを介さずにツールをそのまま呼び、モデルへ渡る文と、プロバイダへの入力を確かめる。
 */

/** 通信しない検索プロバイダ。呼ばれた入力を覚えておく。 */
function createProvider(overrides: Partial<SearchProvider> = {}) {
  const calls = { search: [] as SearchRequest[], fetch: [] as FetchRequest[] };

  const provider: SearchProvider = {
    id: "exa",
    name: "Exa",
    supportsFetch: true,

    async search(request) {
      calls.search.push(request);
      return {
        results: [
          {
            title: "最初の結果",
            url: "https://example.com/one",
            snippet: "短い抜粋",
            publishedAt: "2026-10-01",
          },
          { title: "次の結果", url: "https://example.com/two", snippet: "行 1\n行 2", publishedAt: null },
        ],
      };
    },

    async fetchPage(request) {
      calls.fetch.push(request);
      return { url: request.url, title: "ページの題", text: "本文です。" };
    },

    ...overrides,
  };

  return { provider, calls };
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function run(tools: ToolSet, name: string, input: unknown): Promise<string> {
  const tool = tools[name];
  if (tool?.execute === undefined) throw new Error(`${name} が無い`);
  return (await tool.execute(input as never, {} as never)) as string;
}

describe("web_search / web_fetch", () => {
  test("既定のプロバイダが無ければ、ツールを渡さない", () => {
    const manager: WebSearchManager = {
      provider: () => null,
      test: async () => ({ ok: true, detail: null, results: 0 }),
    };

    expect(createWebSearchToolset({ manager }).toolset()).toEqual({});
  });

  test("プロバイダがあれば 2 つのツールになり、呼ぶたびに設定を読み直す", () => {
    const { provider } = createProvider();
    let current: SearchProvider | null = null;
    const manager: WebSearchManager = {
      provider: () => current,
      test: async () => ({ ok: true, detail: null, results: 0 }),
    };

    const tools = createWebSearchToolset({ manager });
    expect(tools.toolset()).toEqual({});

    current = provider;
    expect(Object.keys(tools.toolset())).toEqual([WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME]);
  });

  test("検索結果は番号付きで並べ、外部の指示に従わないよう添える", async () => {
    const { provider, calls } = createProvider();

    const output = await run(createWebTools({ provider }), WEB_SEARCH_TOOL_NAME, {
      query: "Terasuma",
      limit: 3,
    });

    expect(calls.search).toEqual([{ query: "Terasuma", limit: 3 }]);
    expect(output).toContain('Found 2 result(s) with Exa for "Terasuma".');
    expect(output).toContain("1. 最初の結果");
    expect(output).toContain("   https://example.com/one");
    expect(output).toContain("   2026-10-01");
    expect(output).toContain("   短い抜粋");
    expect(output).toContain("2. 次の結果");
    // 複数行の抜粋は、一覧の字下げに揃える。
    expect(output).toContain("   行 1\n   行 2");
    expect(output).toContain("untrusted input");
  });

  test("検索結果が無いときは、その旨を返す", async () => {
    const { provider } = createProvider({
      async search() {
        return { results: [] };
      },
    });

    expect(await run(createWebTools({ provider }), WEB_SEARCH_TOOL_NAME, { query: "nothing" })).toBe(
      'No results found for "nothing" with Exa.',
    );
  });

  test("ページはタイトル・URL・本文の順に返し、本文が無ければその旨を返す", async () => {
    const { provider, calls } = createProvider();
    const tools = createWebTools({ provider });

    const output = await run(tools, WEB_FETCH_TOOL_NAME, {
      url: "https://example.com/page",
      maxChars: 5_000,
    });
    expect(calls.fetch).toEqual([{ url: "https://example.com/page", maxChars: 5_000 }]);
    expect(output).toBe("ページの題\nhttps://example.com/page\n\n本文です。");

    const empty = createProvider({
      async fetchPage(request) {
        return { url: request.url, title: null, text: "" };
      },
    });

    expect(
      await run(createWebTools({ provider: empty.provider }), WEB_FETCH_TOOL_NAME, {
        url: "https://example.com/empty",
      }),
    ).toBe("https://example.com/empty\n\n(the page had no readable text)");
  });

  test("失敗は、モデルが次にどうすればよいか分かる文にする", async () => {
    const auth = createProvider({
      async search() {
        throw new WebSearchError("auth", "invalid key");
      },
    });

    await expect(
      run(createWebTools({ provider: auth.provider }), WEB_SEARCH_TOOL_NAME, { query: "x" }),
    ).rejects.toThrow("API key was rejected");

    const generic = createProvider({
      async fetchPage() {
        throw new Error("boom");
      },
    });

    await expect(
      run(createWebTools({ provider: generic.provider }), WEB_FETCH_TOOL_NAME, {
        url: "https://example.com",
      }),
    ).rejects.toThrow("Web search failed: boom");
  });
});

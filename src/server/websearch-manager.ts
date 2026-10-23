/**
 * 設定と検索ライブラリの橋渡し。
 *
 * `src/server/websearch/` は Terasuma の設定を知らないので、保存された既定のプロバイダを
 * ここで組み立てる。このファイルはライブラリの外に置く（切り出すときに残るのは向こうだけ）。
 */

import { describeError } from "../shared/errors";
import type { WebSearchTestView } from "../shared/api/settings";
import type { SettingsStore } from "./data/settings";
import {
  createSearchProvider,
  isWebSearchProviderId,
  WebSearchError,
  WEB_SEARCH_FAILURE_TEXT,
  type FetchLike,
  type SearchProvider,
} from "./websearch/index";

/** 接続確認に使う検索語。短く、どのプロバイダでも結果が返るものにする。 */
const TEST_QUERY = "Terasuma web search connection test";

export type WebSearchManager = {
  /** 既定の検索プロバイダ。未設定・設定不備なら null。 */
  provider(): SearchProvider | null;
  /** 保存する前に、渡された API キーで検索できるか確かめる。設定には何も書かない。 */
  test(input: { id: string; apiKey: string | null }, signal?: AbortSignal): Promise<WebSearchTestView>;
};

export function createWebSearchManager(options: { settings: SettingsStore; fetch?: FetchLike }): WebSearchManager {
  return {
    provider() {
      const webSearch = options.settings.read().webSearch;
      const id = webSearch.default;
      if (id === null) return null;

      const provider = webSearch.providers[id];
      if (provider === undefined) return null;

      return safeCreateProvider(id, provider.apiKey, options.fetch);
    },

    async test({ id, apiKey }, signal) {
      if (!isWebSearchProviderId(id)) {
        return { ok: false, detail: `未知の検索プロバイダです: ${id}`, results: 0 };
      }

      // 画面から来たキーは前後に空白が付くことがあるので、検索に使う前に整える。
      const stored = options.settings.read().webSearch.providers[id]?.apiKey ?? null;
      const key = (apiKey ?? stored)?.trim() ?? null;
      if (key === null || key.length === 0) {
        return { ok: false, detail: "API キーが設定されていません", results: 0 };
      }

      try {
        const provider = createSearchProvider({
          id,
          apiKey: key,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        const response = await provider.search({
          query: TEST_QUERY,
          limit: 1,
          ...(signal === undefined ? {} : { signal }),
        });
        return { ok: true, detail: null, results: response.results.length };
      } catch (error) {
        return { ok: false, detail: describeWebSearchError(error), results: 0 };
      }
    },
  };
}

/** 設定に壊れた id が入っていても、ツールを組めないだけで済ませる。 */
function safeCreateProvider(id: string, apiKey: string, fetch?: FetchLike): SearchProvider | null {
  if (!isWebSearchProviderId(id)) return null;

  try {
    return createSearchProvider({ id, apiKey, ...(fetch === undefined ? {} : { fetch }) });
  } catch {
    return null;
  }
}

/** 画面に出す、失敗の理由。ライブラリの英語の文言に、種類の説明を添える。 */
function describeWebSearchError(error: unknown): string {
  if (!(error instanceof WebSearchError)) return describeError(error);
  return WEB_SEARCH_FAILURE_TEXT[error.code].ja(error.message);
}

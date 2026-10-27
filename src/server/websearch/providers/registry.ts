/**
 * プロバイダの登録表と、統一された SearchProvider の組み立て。
 *
 * プロバイダを足すときは、アダプタを作って ADAPTERS と WEB_SEARCH_PROVIDER_IDS に足す。
 * 取得 API を持たないものは fetchPage を実装しなくてよい（直接取得が使われる）。
 */

import { DEFAULT_FETCH_CHARS, MAX_FETCH_CHARS } from "../constants";
import { fetchDirect } from "../direct-fetch";
import { truncateText } from "../../../shared/text";
import type {
  CreateSearchProviderOptions,
  ProviderAdapter,
  ProviderInfo,
  SearchProvider,
  WebSearchProviderId,
} from "../types";
import { brave } from "./brave";
import { exa } from "./exa";
import { numberLimit } from "./helpers";
import { perplexity } from "./perplexity";
import { tavily } from "./tavily";
import { tinyfish } from "./tinyfish";
import { clampInt } from "../../../shared/numbers";

/** 設定に書けるプロバイダ id。並び順は設定画面の候補の順になる。 */
export const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProviderId[] = [
  "exa",
  "tavily",
  "brave",
  "perplexity",
  "tinyfish",
];

/** プロバイダ id → 実装。全 id を持つことを型で確かめる。 */
const ADAPTERS: Record<WebSearchProviderId, ProviderAdapter> = {
  exa,
  tavily,
  brave,
  perplexity,
  tinyfish,
};

/** 設定画面に出すプロバイダの一覧。 */
export const WEB_SEARCH_PROVIDERS: readonly ProviderInfo[] = WEB_SEARCH_PROVIDER_IDS.map((id) => providerInfo(id));

/** 設定に書かれた id が使えるかどうか。 */
export function isWebSearchProviderId(value: string): value is WebSearchProviderId {
  return (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

/** プロバイダの表示名と、取得 API の有無。 */
export function providerInfo(id: WebSearchProviderId): ProviderInfo {
  const adapter = ADAPTERS[id];
  return { id, name: adapter.name, supportsFetch: adapter.supportsFetch };
}

/** 統一された検索プロバイダを作る。取得 API が無ければ直接取得を使う。 */
export function createSearchProvider(options: CreateSearchProviderOptions): SearchProvider {
  const adapter = ADAPTERS[options.id];
  if (adapter === undefined) {
    throw new Error(`Unknown web search provider "${options.id}".`);
  }

  const context = {
    apiKey: options.apiKey,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };

  return {
    id: adapter.id,
    name: adapter.name,
    supportsFetch: adapter.supportsFetch,

    search(request) {
      return adapter.search(context, { ...request, limit: numberLimit(request.limit) });
    },

    async fetchPage(request) {
      const maxChars = clampChars(request.maxChars ?? DEFAULT_FETCH_CHARS);
      const normalized = { ...request, maxChars };
      const response =
        adapter.fetchPage === undefined
          ? await fetchDirect(context.fetch, normalized)
          : await adapter.fetchPage(context, normalized);

      return { ...response, text: truncateText(response.text, maxChars, "parens") };
    },
  };
}

function clampChars(value: number): number {
  return clampInt(value, 1_000, MAX_FETCH_CHARS);
}

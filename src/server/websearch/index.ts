/**
 * 検索ライブラリの公開 API。
 *
 * ここから外へ出すものだけを並べる。Terasuma の設定には触れない。
 * 通信の共通部分（タイムアウト・失敗本文の解析）は server/http/client.ts に置き、
 * 検索プロバイダごとの URL・本文・応答の読み方だけをこのディレクトリに持つ。
 */

export { DEFAULT_FETCH_CHARS, DEFAULT_SEARCH_LIMIT, MAX_FETCH_CHARS, MAX_SEARCH_LIMIT } from "./constants";
export { WebSearchError, type WebSearchErrorCode } from "./errors";
export { WEB_SEARCH_FAILURE_TEXT } from "./failure-text";
export { decodeEntities, htmlToText, pageTitle } from "./html";
export {
  createSearchProvider,
  isWebSearchProviderId,
  providerInfo,
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDERS,
} from "./providers/registry";
export type {
  CreateSearchProviderOptions,
  FetchLike,
  FetchRequest,
  FetchResponse,
  ProviderAdapter,
  ProviderContext,
  ProviderInfo,
  SearchProvider,
  SearchRequest,
  SearchResponse,
  SearchResult,
  WebSearchProviderId,
} from "./types";

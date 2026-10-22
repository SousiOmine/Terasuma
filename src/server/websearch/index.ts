/**
 * 検索ライブラリの公開 API。
 *
 * ここから外へ出すものだけを並べる。Terasuma 固有の設定や HTTP には触れないので、
 * このディレクトリごと別のリポジトリへ移しても動く。
 */

export { DEFAULT_FETCH_CHARS, DEFAULT_SEARCH_LIMIT, MAX_FETCH_CHARS, MAX_SEARCH_LIMIT } from "./constants";
export { WebSearchError, type WebSearchErrorCode } from "./errors";
export { decodeEntities, htmlToText, pageTitle } from "./html";
export { errorMessage, truncateText } from "./text";
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

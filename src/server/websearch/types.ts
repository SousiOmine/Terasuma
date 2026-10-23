/**
 * 検索プロバイダの形。
 *
 * 検索プロバイダとのやり取りの形。通信そのものは server/http/client.ts が持ち、
 * ここにはプロバイダごとの入力と出力だけを置く。
 */

/** fetch の差し替え口。テストでは通信せずに応答を返せる。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 使える検索プロバイダ。追加するときは registry.ts の表にも足す。 */
export type WebSearchProviderId = "exa" | "tavily" | "brave" | "perplexity" | "tinyfish";

/** 検索の入力。 */
export type SearchRequest = {
  query: string;
  /** 返す件数。1 以上を渡す（プロバイダ側でも上限に収める）。 */
  limit: number;
  /** 呼び出し元の中断。 */
  signal?: AbortSignal;
};

/** 検索結果 1 件。 */
export type SearchResult = {
  title: string;
  url: string;
  /** 一覧に出す抜粋。改行は含めない。 */
  snippet: string;
  /** 公開日。分からなければ null。 */
  publishedAt: string | null;
};

export type SearchResponse = {
  results: SearchResult[];
};

/** ページ取得の入力。 */
export type FetchRequest = {
  url: string;
  /** 返す本文の上限（文字数）。省略時は既定値。 */
  maxChars?: number;
  signal?: AbortSignal;
};

/** ページ取得の結果。 */
export type FetchResponse = {
  /** リダイレクト後の URL。 */
  url: string;
  title: string | null;
  text: string;
};

/** 利用側が使う、統一された検索プロバイダ。 */
export type SearchProvider = {
  readonly id: WebSearchProviderId;
  readonly name: string;
  /** プロバイダ自身のページ取得 API を持つかどうか。 */
  readonly supportsFetch: boolean;
  search(request: SearchRequest): Promise<SearchResponse>;
  /** 取得 API を持たないプロバイダは、直接取得で本文を返す。 */
  fetchPage(request: FetchRequest): Promise<FetchResponse>;
};

/** プロバイダ実装が受け取る、認証と通信の口。 */
export type ProviderContext = {
  apiKey: string;
  fetch: FetchLike;
};

/** 各プロバイダの実装。fetchPage を持たないものは直接取得を使う。 */
export type ProviderAdapter = {
  readonly id: WebSearchProviderId;
  readonly name: string;
  readonly supportsFetch: boolean;
  search(context: ProviderContext, request: SearchRequest): Promise<SearchResponse>;
  fetchPage?(context: ProviderContext, request: FetchRequest): Promise<FetchResponse>;
};

/** 設定画面に出すプロバイダの情報。 */
export type ProviderInfo = {
  id: WebSearchProviderId;
  name: string;
  supportsFetch: boolean;
};

/** プロバイダを作るための入力。 */
export type CreateSearchProviderOptions = {
  id: WebSearchProviderId;
  apiKey: string;
  /** テストで差し替える fetch。 */
  fetch?: FetchLike;
};

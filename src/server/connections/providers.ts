/**
 * アプリの接続に使うプロバイダの定義。
 *
 * Device Flow（RFC 8628）でサインインできるアプリだけを並べる。
 * アプリを足すときは、ここに定義を 1 つ足す（画面と API はこの定義から組み立てる）。
 * 認可のやり取りは device-flow.ts、状態と待ちは manager.ts が受け持つ。
 */

/** Device Flow でサインインできるアプリ 1 件の定義。 */
export type DeviceFlowProvider = {
  /** 設定のキーとツールの引数に使う id。 */
  id: string;
  /** 画面に出す名前。 */
  name: string;
  /** 設定画面に出す説明。 */
  description: string;
  /** アプリを登録するためのページ。 */
  setupUrl: string;
  /** デバイスコードを要求する先。 */
  deviceCodeUrl: string;
  /** デバイスコードをトークンに交換する先。 */
  tokenUrl: string;
  /** 要求する権限。 */
  scopes: readonly string[];
  /** 接続がコンピュータへ渡す環境変数の名前。 */
  env: readonly string[];
  /** 接続したアカウントの API。モデルが app_request で叩く先でもある。 */
  api: {
    baseUrl: string;
    /** すべての要求に付けるヘッダー。 */
    headers: Record<string, string>;
    /** アカウント名を読むための API。 */
    account: { path: string; field: string };
  };
};

/**
 * GitHub。
 *
 * 利用者が OAuth App を作り、「Enable Device Flow」を有効にした Client ID を使う。
 * client secret は使わない（Device Flow は公開クライアント向けの流れのため）。
 * scope の repo は私有リポジトリも含む。
 */
const GITHUB: DeviceFlowProvider = {
  id: "github",
  name: "GitHub",
  description: "リポジトリの読み書きと GitHub API",
  setupUrl: "https://github.com/settings/developers",
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scopes: ["repo", "read:user"],
  env: ["GH_TOKEN", "GITHUB_TOKEN"],
  api: {
    baseUrl: "https://api.github.com",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    account: { path: "/user", field: "login" },
  },
};

/** 標準で使えるプロバイダ。並び順が設定画面の並び順になる。 */
export const CONNECTION_PROVIDERS: readonly DeviceFlowProvider[] = [GITHUB];

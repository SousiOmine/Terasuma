/**
 * アプリの接続に使うプロバイダの定義。
 *
 * 認可の方法は 2 つある。
 * - device: Device Flow（RFC 8628）。GitHub のように、コードを画面に出してブラウザで承認する。
 * - bot: 利用者が発行したトークンを貼る。Discord の bot トークンのように、
 *        OAuth の同意画面では取れない資格情報を使う。
 *
 * アプリを足すときは、ここに定義を 1 つ足す（画面と API はこの定義から組み立てる）。
 * 認可のやり取りは device-flow.ts、状態と待ちは manager.ts が受け持つ。
 */

/** どのプロバイダにも共通する部分。 */
type ConnectionProviderBase = {
  /** 設定のキーとツールの引数に使う id。 */
  id: string;
  /** 画面に出す名前。 */
  name: string;
  /** 設定画面に出す説明。 */
  description: string;
  /** アプリを登録するためのページ。 */
  setupUrl: string;
  /** 接続がコンピュータへ渡す環境変数の名前。 */
  env: readonly string[];
  /** 接続できたときにツールへ返す、API の使い方の例。 */
  usage: string;
  /** 接続したアカウントの API。モデルが app_request で叩く先でもある。 */
  api: {
    baseUrl: string;
    /** すべての要求に付けるヘッダー。 */
    headers: Record<string, string>;
    /** アカウント名を読むための API。 */
    account: { path: string; field: string };
    /**
     * Authorization ヘッダーの値。省略すると `Bearer <token>`。
     * Discord の bot トークンのように、`Bot <token>` を要求する API で使う。
     */
    authorization?(token: string): string;
  };
};

/** Device Flow でサインインするアプリ。 */
export type DeviceFlowProvider = ConnectionProviderBase & {
  kind: "device";
  /** デバイスコードを要求する先。 */
  deviceCodeUrl: string;
  /** デバイスコードをトークンに交換する先。 */
  tokenUrl: string;
  /** 要求する scope。Device Flow の要求にそのまま載せる。 */
  scopes: readonly string[];
};

/**
 * 利用者が発行したトークンを貼るアプリ。
 *
 * OAuth ではトークンが取れない API（Discord の bot など）はこちらを使う。
 * トークンは画面からは見えない形で保存し、設定画面では保存済みかどうかだけを返す。
 */
export type BotTokenProvider = ConnectionProviderBase & {
  kind: "bot";
  /** 画面に出す、要求する権限。 */
  permissions: readonly string[];
  /** アプリをサーバーへ追加するリンクの材料。 */
  invite?: {
    authorizeUrl: string;
    scope: string;
    /** API が解釈する権限の数値。 */
    permissions: string;
  };
};

/** 標準で使えるプロバイダ。 */
export type ConnectionProvider = DeviceFlowProvider | BotTokenProvider;

/**
 * GitHub。
 *
 * 利用者が OAuth App を作り、「Enable Device Flow」を有効にした Client ID を使う。
 * client secret は使わない（Device Flow は公開クライアント向けの流れのため）。
 * scope の repo は私有リポジトリも含む。
 */
const GITHUB: DeviceFlowProvider = {
  kind: "device",
  id: "github",
  name: "GitHub",
  description: "リポジトリの読み書きと GitHub API",
  setupUrl: "https://github.com/settings/developers",
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scopes: ["repo", "read:user"],
  env: ["GH_TOKEN", "GITHUB_TOKEN"],
  usage:
    'For git over HTTPS, pass -c http.extraHeader="Authorization: Bearer $GH_TOKEN". ' +
    "For the API, use app_request (for example GET /user).",
  api: {
    baseUrl: "https://api.github.com",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    account: { path: "/user", field: "login" },
  },
};

/**
 * Discord（bot）。
 *
 * OAuth のユーザートークンではメッセージを送れない（送信の scope が無く、
 * ユーザーアカウントの自動操作は規約で禁止されている）。そのため bot を作り、
 * Developer Portal で発行したトークンを貼る。
 *
 * メッセージ本文を読むには、ポータルの Bot ページで MESSAGE_CONTENT を有効にする。
 * 招待リンクの権限は、チャンネルを見る・メッセージを送る・履歴を読むの 3 つだけにする。
 */
const DISCORD: BotTokenProvider = {
  kind: "bot",
  id: "discord",
  name: "Discord",
  description: "ボットとしてメッセージを読み書きする",
  setupUrl: "https://discord.com/developers/applications",
  permissions: ["View Channel", "Send Messages", "Read Message History"],
  env: ["DISCORD_BOT_TOKEN"],
  usage:
    "For the API, use app_request (for example GET /channels/{channel_id}/messages " +
    'or POST /channels/{channel_id}/messages with a JSON body like {"content": "..."}).',
  invite: {
    authorizeUrl: "https://discord.com/oauth2/authorize",
    scope: "bot",
    // VIEW_CHANNEL (1<<10) | SEND_MESSAGES (1<<11) | READ_MESSAGE_HISTORY (1<<16)
    permissions: "68608",
  },
  api: {
    baseUrl: "https://discord.com/api/v10",
    headers: { Accept: "application/json" },
    account: { path: "/users/@me", field: "username" },
    authorization: (token) => `Bot ${token}`,
  },
};

/** 標準で使えるプロバイダ。並び順が設定画面の並び順になる。 */
export const CONNECTION_PROVIDERS: readonly ConnectionProvider[] = [GITHUB, DISCORD];

/** Authorization ヘッダーの値。プロバイダごとの方式（Bearer / Bot）をここに集める。 */
export function authorizationHeader(provider: ConnectionProvider, token: string): string {
  return provider.api.authorization?.(token) ?? `Bearer ${token}`;
}

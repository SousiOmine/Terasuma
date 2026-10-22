/**
 * アプリの接続に使うプロバイダの定義。
 *
 * 接続はすべて「利用者が発行したトークンを貼る」方式に統一している。
 * GitHub は Personal Access Token、Discord は Bot トークンを使う。
 * アプリを足すときは、ここに定義を 1 つ足す（画面と API はこの定義から組み立てる）。
 * トークンの保存と検証は manager.ts、アカウントの読み取りは account.ts が受け持つ。
 */

/** 接続に共通する定義。 */
export type ConnectionProvider = {
  /** 設定のキーとツールの引数に使う id。 */
  id: string;
  /** 画面に出す名前。 */
  name: string;
  /** 設定画面に出す説明。 */
  description: string;
  /** トークンを発行するページ。 */
  setupUrl: string;
  /** 画面に出すトークン欄の見出しと説明。 */
  token: {
    label: string;
    description: string;
    placeholder: string;
  };
  /** トークンに付ける権限。画面に出す（GitHub は scope、Discord は API の権限名）。 */
  permissions: readonly string[];
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
  /**
   * 招待リンクに使う Application ID を設定するアプリ（Discord）。
   * 定義すると、設定画面に Application ID 欄と「サーバーに追加」リンクが出る。
   */
  invite?: {
    authorizeUrl: string;
    scope: string;
    /** API が解釈する権限の数値。 */
    permissions: string;
  };
};

/**
 * GitHub。
 *
 * Personal Access Token（classic）の `repo` と `read:user` を使う。
 * トークンの発行ページは、スコープと説明を埋めた URL で開く。
 * fine-grained token でも動くが、作成の手間が増えるため classic を案内する。
 */
const GITHUB: ConnectionProvider = {
  id: "github",
  name: "GitHub",
  description: "リポジトリの読み書きと GitHub API",
  setupUrl: "https://github.com/settings/tokens/new?scopes=repo,read:user&description=Terasuma",
  token: {
    label: "Personal Access Token",
    description:
      "repo と read:user を付けた Personal Access Token（classic）を貼り付けます。リンクから、スコープを埋めた状態で発行できます。",
    placeholder: "ghp_...",
  },
  permissions: ["repo", "read:user"],
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
 * 招待リンクの権限は、チャンネルを見る・メッセージを送る・履歴を読む 3 つだけにする。
 */
const DISCORD: ConnectionProvider = {
  id: "discord",
  name: "Discord",
  description: "ボットとしてメッセージを読み書きする",
  setupUrl: "https://discord.com/developers/applications",
  token: {
    label: "Bot トークン",
    description:
      "Bot ページの Reset Token で発行したトークンを貼り付けます。保存する前に、そのトークンでアカウントを確かめます。",
    placeholder: "Bot トークンを貼り付け",
  },
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

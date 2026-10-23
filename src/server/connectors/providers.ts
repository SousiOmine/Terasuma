/**
 * コネクタに使うプロバイダの定義。
 *
 * コネクタはすべて「利用者が発行したトークンを貼る」方式に統一している。
 * GitHub は Personal Access Token を使う。
 * コネクタを足すときは、ここに定義を 1 つ足す（画面と API はこの定義から組み立てる）。
 * トークンの保存と検証は manager.ts、アカウントの読み取りは account.ts が受け持つ。
 *
 * Discord はここには無い。送信先の webhook URL を Tera ごとに保存する別の仕組みで、
 * server/discord が受け持つ（webhook は投稿だけができ、読み取りはできないため）。
 */

/** コネクタに共通する定義。 */
export type ConnectorProvider = {
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
  /** トークンに付ける権限。画面に出す（GitHub は scope）。 */
  permissions: readonly string[];
  /** コネクタがコンピュータへ渡す環境変数の名前。 */
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
  };
};

/**
 * GitHub。
 *
 * Personal Access Token（classic）の `repo` と `read:user` を使う。
 * トークンの発行ページは、スコープと説明を埋めた URL で開く。
 * fine-grained token でも動くが、作成の手間が増えるため classic を案内する。
 */
const GITHUB: ConnectorProvider = {
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
    `For git over HTTPS, pass -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'. ` +
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

/** 標準で使えるプロバイダ。並び順が設定画面の並び順になる。 */
export const CONNECTOR_PROVIDERS: readonly ConnectorProvider[] = [GITHUB];

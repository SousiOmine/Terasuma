/**
 * コネクタに使うプロバイダの定義。
 *
 * コネクタには 2 種類ある。
 * - token: 利用者が発行したトークンを貼る（GitHub）。
 * - program: コンピュータの中のプログラムに LLM を繋ぐ（pi）。
 * コネクタを足すときは、ここに定義を 1 つ足す（画面と API はこの定義から組み立てる）。
 * トークンの保存と検証は manager.ts、アカウントの読み取りは account.ts が受け持つ。
 *
 * Discord はここには無い。送信先の webhook URL を Tera ごとに保存する別の仕組みで、
 * server/discord が受け持つ（webhook は投稿だけができ、読み取りはできないため）。
 */

/** コネクタに共通する定義。 */
export type ConnectorCommon = {
  /** 設定のキーとツールの引数に使う id。 */
  id: string;
  /** 画面に出す名前。 */
  name: string;
  /** 設定画面に出す説明。 */
  description: string;
  /** 設定や接続の手順を開くページ。 */
  setupUrl: string;
  /** 画面に出す、要求する権限（GitHub は scope）。 */
  permissions: readonly string[];
  /** 接続に何が要るか（モデルへ見せる英語の 1 文）。 */
  needs: string;
  /** 接続できたときにツールへ返す、使い方の例。 */
  usage: string;
};

/** 利用者が発行したトークンを貼るコネクタ（GitHub、Composio）。 */
export type TokenConnectorProvider = ConnectorCommon & {
  kind: "token";
  /** 画面に出すトークン欄の見出しと説明。 */
  token: { label: string; description: string; placeholder: string };
  /**
   * コネクタがコンピュータへ渡す環境変数の名前。
   * 空にすると、トークンはコンテナへ渡らない（コンテナの中の bash からも読めない）。
   */
  env: readonly string[];
  /** 接続したアカウントの API。モデルが app_request で叩く先でもある。 */
  api: {
    baseUrl: string;
    /** すべての要求に付けるヘッダー。 */
    headers: Record<string, string>;
    /**
     * トークンを載せるヘッダー。
     * GitHub は Authorization に "Bearer " を付けた値を載せ、Composio は x-api-key にトークンそのものを載せる
     * （Composio は両方を同時に渡すと 401 で断る）。
     */
    auth: { header: string; prefix: string };
    /**
     * 貼られたトークンを受け付けるか確かめる API。保存の前に必ず通す。
     * field が null なら、応答の成否だけで判断し、アカウント名は取らない
     * （Composio のキーには対応するアカウント名が無い）。
     */
    verify: { path: string; field: string | null };
  };
};

/** program コネクタで選ぶ、繋ぎ先の LLM。 */
export type ProgramProviderChoice = {
  /** pi の provider id（auth.json と settings.json のキー）。 */
  id: string;
  /** 画面に出す名前。 */
  label: string;
  /** モデルを書かなかったときに使うモデル。 */
  defaultModel: string;
};

/** コンピュータの中のプログラムを確かめ、設定するコネクタ（pi）。 */
export type ProgramConnectorProvider = ConnectorCommon & {
  kind: "program";
  /** 設定画面とチャットのカードに出す欄。 */
  setup: {
    /** 繋ぎ先の LLM を選ぶ欄。 */
    provider: { label: string; description: string; choices: readonly ProgramProviderChoice[] };
    /** API キーを入れる欄。値はモデルへ返さない。 */
    key: { label: string; description: string; placeholder: string };
    /** モデルを入れる欄。空なら choices の defaultModel を使う。 */
    model: { label: string; description: string; placeholder: string };
  };
};

export type ConnectorProvider = TokenConnectorProvider | ProgramConnectorProvider;

/**
 * GitHub。
 *
 * Personal Access Token（classic）の `repo` と `read:user` を使う。
 * トークンの発行ページは、スコープと説明を埋めた URL で開く。
 * fine-grained token でも動くが、作成の手間が増えるため classic を案内する。
 */
const GITHUB: TokenConnectorProvider = {
  kind: "token",
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
  needs: "a personal access token (classic) with the repo and read:user scopes",
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
    auth: { header: "Authorization", prefix: "Bearer " },
    verify: { path: "/user", field: "login" },
  },
};

/**
 * Composio。1,600 以上のアプリのツールを、1 つのプロジェクト API キーで検索して実行する。
 *
 * キーはコンテナへ渡さない（`env` を空にする）。ツールは Terasuma のサーバーから叩くので、
 * コンテナの中のコマンドがキーを読む必要が無い。
 *
 * キーは scoped project key を作るのが安全。Terasuma は保存時に `GET /tools` で確かめるので
 * Toolkits read が要り、実行には Tool execution write が要る（権限不足も Composio 側では
 * 401 Invalid API key として返る）。
 */
const COMPOSIO: TokenConnectorProvider = {
  kind: "token",
  id: "composio",
  name: "Composio",
  description: "Gmail、Slack、Notion など 1,600 以上のアプリのツール。実行は Composio のサーバーを経由します。",
  setupUrl: "https://dashboard.composio.dev/~/project/settings/api-keys",
  token: {
    label: "プロジェクト API キー",
    description:
      "Composio のダッシュボードで発行したプロジェクト API キーを貼り付けます。アプリごとの権限を絞るなら scoped key を作ってください" +
      "（保存時の確認に Toolkits の読み取り、ツールの実行に Tool execution の書き込みが要ります）。",
    placeholder: "ak_...",
  },
  permissions: [],
  needs: "a Composio project API key",
  env: [],
  usage:
    "Find a tool with app_composio_search, then run it with app_composio_execute and the arguments its schema shows. " +
    "For REST calls the tools do not cover, use app_request (for example GET /tools/GITHUB_CREATE_ISSUE).",
  api: {
    baseUrl: "https://backend.composio.dev/api/v3.1",
    headers: { Accept: "application/json" },
    auth: { header: "x-api-key", prefix: "" },
    verify: { path: "/tools", field: null },
  },
};

/** pi（pi-coding-agent）。コンピュータの中の CLI に LLM を繋いで、tmux 越しに呼ぶ。 */
const PI: ProgramConnectorProvider = {
  kind: "program",
  id: "pi",
  name: "pi-coding-agent",
  description: "コンピュータの中のコーディングエージェント。LLM を繋いで、コードを書かせます。",
  setupUrl: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
  permissions: [],
  needs:
    "the LLM provider to use, an API key for that provider, and a model (leave the model empty to use the provider's default)",
  usage: "Load the pi-coding skill and drive pi through tmux; do not edit code yourself.",
  setup: {
    provider: {
      label: "LLM のプロバイダ",
      description: "pi が使うプロバイダを選びます。API キーは、そのプロバイダで発行したものを貼り付けます。",
      choices: [
        { id: "anthropic", label: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-5" },
        { id: "openai", label: "OpenAI (GPT)", defaultModel: "gpt-5.3-codex" },
        { id: "google", label: "Google (Gemini)", defaultModel: "gemini-3.5-flash" },
        { id: "deepseek", label: "DeepSeek", defaultModel: "deepseek-v4-pro" },
        { id: "xai", label: "xAI (Grok)", defaultModel: "grok-4.5" },
        { id: "mistral", label: "Mistral", defaultModel: "devstral-latest" },
        { id: "groq", label: "Groq", defaultModel: "openai/gpt-oss-120b" },
        { id: "cerebras", label: "Cerebras", defaultModel: "gpt-oss-120b" },
        { id: "together", label: "Together AI", defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash" },
        { id: "fireworks", label: "Fireworks", defaultModel: "accounts/fireworks/models/deepseek-v4p1-flash" },
        { id: "moonshotai", label: "Moonshot AI (Kimi)", defaultModel: "kimi-k2.7-code" },
        { id: "minimax", label: "MiniMax", defaultModel: "MiniMax-M2.7" },
        { id: "zai", label: "Z.ai Coding Plan", defaultModel: "glm-5.2" },
        { id: "openrouter", label: "OpenRouter", defaultModel: "anthropic/claude-sonnet-4.5" },
        { id: "opencode-go", label: "OpenCode Go", defaultModel: "deepseek-v4.1-flash" },
      ],
    },
    key: {
      label: "API キー",
      description:
        "選んだプロバイダで発行した API キーを貼り付けます。キーはコンピュータの中の pi の設定（0600）にだけ保存し、会話には残しません。",
      placeholder: "sk-...",
    },
    model: {
      label: "モデル",
      description: "空のままなら、選んだプロバイダの既定のモデルを使います。",
      placeholder: "既定のモデル",
    },
  },
};

/** 標準で使えるプロバイダ。並び順が設定画面の並び順になる。 */
export const CONNECTOR_PROVIDERS: readonly ConnectorProvider[] = [GITHUB, COMPOSIO, PI];

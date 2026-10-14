/**
 * 設定画面から追加できるプロバイダの一覧。
 * サーバとクライアントの両方が読む静的なデータで、秘密は含まない。
 *
 * モデルの呼び出し方（どの URL にどのプロトコルで投げるか）は Mastra のモデルルーターが持っている。
 * ここが持つのは「どのプロバイダを設定画面に並べるか」と「モデル一覧をどう取りに行くか」だけ。
 */

export type ProviderCatalogId =
  | "deepseek"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "xai"
  | "groq"
  | "mistral"
  | "ollama"
  | "custom";

/** モデル一覧を取りに行くときの認証の当て方。 */
export type ModelsAuth = "bearer" | "x-api-key";

type ProviderCatalogCommon = {
  id: ProviderCatalogId;
  /** 画面に出す名前。固有名詞なので翻訳せず、翻訳が要るものはクライアント側が差し替える。 */
  name: string;
  /** API キーの取得先。キーが要らないプロバイダは null。 */
  keyUrl: string | null;
  /** API キーが必須かどうか。false でも入力欄は出し、空のままを許す。 */
  requiresApiKey: boolean;
  /** 一覧の中で最初に選ぶモデル。ここに挙げた ID が一覧に無ければ先頭を使う。 */
  preferredModels: readonly string[];
};

/**
 * 既知のプロバイダ。モデルの呼び出しは Mastra のモデルルーターに任せるので、
 * アプリ側はベース URL を持たない（設定ファイルにも書かない）。
 */
export type BuiltinProviderEntry = ProviderCatalogCommon & {
  kind: "builtin";
  /** モデル一覧を取る絶対 URL。 */
  modelsUrl: string;
  modelsAuth: ModelsAuth;
  /** 一覧を取るときに足すヘッダ（Anthropic のバージョン指定など）。 */
  modelsHeaders?: Record<string, string>;
  /** 返ってくる ID から取り除く接頭辞（Google の OpenAI 互換 API は "models/" を付けて返す）。 */
  modelsIdPrefix?: string;
};

/**
 * OpenAI 互換のエンドポイント。接続先を利用者が決める（Ollama や社内のゲートウェイ）。
 * モデルの呼び出しにはこのベース URL を Mastra へ渡す。
 */
export type OpenAICompatibleProviderEntry = ProviderCatalogCommon & {
  kind: "openai-compatible";
  /** 追加時に最初から入れておくベース URL。利用者に入れさせる場合は null。 */
  defaultBaseUrl: string | null;
  /**
   * 利用者が付ける名前を持つかどうか。
   * true のエントリは「プロバイダの種類」ではなく 1 つの接続先を表すので、表示名を settings に保存する。
   */
  requiresLabel: boolean;
};

export type ProviderCatalogEntry = BuiltinProviderEntry | OpenAICompatibleProviderEntry;

/**
 * 名前を付けて追加する OpenAI 互換エンドポイントの雛形。
 * このエントリはプロバイダの種類ではなく 1 つの接続先を表すので、保存する id は追加のたびに作る。
 */
export const OPENAI_COMPATIBLE_TEMPLATE: OpenAICompatibleProviderEntry = {
  id: "custom",
  kind: "openai-compatible",
  name: "OpenAI compatible",
  keyUrl: null,
  requiresApiKey: false,
  defaultBaseUrl: null,
  requiresLabel: true,
  preferredModels: [],
};

/** 設定画面に並べる順。上から順に、よく使うものと設定が簡単なものを置く。 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: "deepseek",
    kind: "builtin",
    name: "DeepSeek",
    keyUrl: "https://platform.deepseek.com/api_keys",
    requiresApiKey: true,
    modelsUrl: "https://api.deepseek.com/models",
    modelsAuth: "bearer",
    preferredModels: ["deepseek-v4-pro", "deepseek-flash"],
  },
  {
    id: "openai",
    kind: "builtin",
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    requiresApiKey: true,
    modelsUrl: "https://api.openai.com/v1/models",
    modelsAuth: "bearer",
    preferredModels: ["gpt-5.6-sol", "gpt-5.6"],
  },
  {
    id: "anthropic",
    kind: "builtin",
    name: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    requiresApiKey: true,
    modelsUrl: "https://api.anthropic.com/v1/models",
    modelsAuth: "x-api-key",
    modelsHeaders: { "anthropic-version": "2023-06-01" },
    preferredModels: ["claude-sonnet-4-6", "claude-opus-4-6"],
  },
  {
    id: "google",
    kind: "builtin",
    name: "Google",
    keyUrl: "https://aistudio.google.com/app/apikey",
    requiresApiKey: true,
    // OpenAI 互換の口を使う。Mastra 側の Google プロバイダとモデル ID の付け方が同じ。
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    modelsAuth: "bearer",
    modelsIdPrefix: "models/",
    preferredModels: ["gemini-3.5-flash", "gemini-2.5-pro"],
  },
  {
    id: "openrouter",
    kind: "builtin",
    name: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    requiresApiKey: true,
    modelsUrl: "https://openrouter.ai/api/v1/models",
    modelsAuth: "bearer",
    preferredModels: ["anthropic/claude-sonnet-4.6"],
  },
  {
    id: "xai",
    kind: "builtin",
    name: "xAI",
    keyUrl: "https://console.x.ai",
    requiresApiKey: true,
    modelsUrl: "https://api.x.ai/v1/models",
    modelsAuth: "bearer",
    preferredModels: ["grok-4.7"],
  },
  {
    id: "groq",
    kind: "builtin",
    name: "Groq",
    keyUrl: "https://console.groq.com/keys",
    requiresApiKey: true,
    modelsUrl: "https://api.groq.com/openai/v1/models",
    modelsAuth: "bearer",
    preferredModels: ["openai/gpt-oss-120b"],
  },
  {
    id: "mistral",
    kind: "builtin",
    name: "Mistral",
    keyUrl: "https://console.mistral.ai/api-keys",
    requiresApiKey: true,
    modelsUrl: "https://api.mistral.ai/v1/models",
    modelsAuth: "bearer",
    preferredModels: ["mistral-large-latest"],
  },
  {
    id: "ollama",
    kind: "openai-compatible",
    name: "Ollama",
    keyUrl: null,
    requiresApiKey: false,
    // Ollama の OpenAI 互換の口。既定の待ち受けポートは 11434。
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    requiresLabel: false,
    preferredModels: [],
  },
  OPENAI_COMPATIBLE_TEMPLATE,
];

export function findProviderCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.id === id);
}

/** 保存されたプロバイダ id が、カタログの既知のプロバイダかどうか。 */
export function isCatalogProviderId(id: string): id is ProviderCatalogId {
  return findProviderCatalogEntry(id) !== undefined;
}

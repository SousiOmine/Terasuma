/**
 * プロバイダの種別ごとの知識を 1 つの表にまとめる。
 *
 * これまでは「使うパッケージ」「providerOptions のキー」「ツール結果に画像を置けるか」
 * 「思考強度の渡し方」が別々の表と switch に分かれていた。プロバイダを 1 つ足すたびに
 * 5 か所を直すことになり、直し忘れが起きる。種別ごとの事実はここだけに置く。
 *
 * AI SDK のパッケージを使うのは adapters.ts だけ。ここは import を持たない純粋な表にして、
 * HTTP 層やカタログの読み取りが重い依存を読み込まないようにする。
 */

/** 呼び出しに使う AI SDK のパッケージ（種別）。 */
export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "groq"
  | "mistral"
  | "cerebras"
  | "deepinfra"
  | "togetherai"
  | "perplexity"
  | "openrouter"
  | "openai-compatible";

/** 思考強度の渡し方。 */
export type ReasoningStyle = "reasoning-effort" | "anthropic-effort" | "google-thinking";

/** 種別ごとの事実。 */
type KindSpec = {
  /** models.dev が示す npm 名。 */
  npm: string;
  /** providerOptions のキー。OpenAI 互換だけは呼び出し側の id を使う。 */
  optionKey: string;
  /** ツール結果の content に画像を置けるか。置けない場合は user メッセージで渡す。 */
  takesToolResultImages: boolean;
  /** 思考強度の渡し方。 */
  reasoning: ReasoningStyle;
};

/** 種別ごとの事実の表。 */
export const PROVIDER_KINDS: Record<ProviderKind, KindSpec> = {
  openai: {
    npm: "@ai-sdk/openai",
    optionKey: "openai",
    takesToolResultImages: true,
    reasoning: "reasoning-effort",
  },
  anthropic: {
    npm: "@ai-sdk/anthropic",
    optionKey: "anthropic",
    takesToolResultImages: true,
    reasoning: "anthropic-effort",
  },
  google: {
    npm: "@ai-sdk/google",
    optionKey: "google",
    takesToolResultImages: true,
    reasoning: "google-thinking",
  },
  xai: {
    npm: "@ai-sdk/xai",
    optionKey: "xai",
    takesToolResultImages: true,
    reasoning: "reasoning-effort",
  },
  groq: {
    npm: "@ai-sdk/groq",
    optionKey: "groq",
    takesToolResultImages: false,
    reasoning: "reasoning-effort",
  },
  mistral: {
    npm: "@ai-sdk/mistral",
    optionKey: "mistral",
    takesToolResultImages: false,
    reasoning: "reasoning-effort",
  },
  cerebras: {
    npm: "@ai-sdk/cerebras",
    optionKey: "cerebras",
    takesToolResultImages: false,
    reasoning: "reasoning-effort",
  },
  deepinfra: {
    npm: "@ai-sdk/deepinfra",
    optionKey: "deepinfra",
    takesToolResultImages: false,
    reasoning: "reasoning-effort",
  },
  togetherai: {
    npm: "@ai-sdk/togetherai",
    optionKey: "togetherai",
    takesToolResultImages: false,
    reasoning: "reasoning-effort",
  },
  perplexity: {
    npm: "@ai-sdk/perplexity",
    optionKey: "perplexity",
    takesToolResultImages: false,
    reasoning: "reasoning-effort",
  },
  openrouter: {
    npm: "@openrouter/ai-sdk-provider",
    optionKey: "openrouter",
    takesToolResultImages: true,
    reasoning: "reasoning-effort",
  },
  "openai-compatible": {
    npm: "@ai-sdk/openai-compatible",
    optionKey: "",
    takesToolResultImages: true,
    reasoning: "reasoning-effort",
  },
};

/** models.dev の npm 名 → 種別。 */
const KIND_BY_NPM: ReadonlyMap<string, ProviderKind> = new Map(
  (Object.entries(PROVIDER_KINDS) as [ProviderKind, KindSpec][]).map(([kind, spec]) => [spec.npm, kind]),
);

/** models.dev の npm 名から種別を引く。依存に無いパッケージなら null。 */
export function providerKindForNpm(npm: string | null): ProviderKind | null {
  return npm === null ? null : (KIND_BY_NPM.get(npm) ?? null);
}

/** モデル 1 件を呼ぶのに必要な、パッケージと providerOptions のキー。 */
export type ProviderSpec = {
  /** models.dev のプロバイダ id。 */
  id: string;
  kind: ProviderKind;
  /** providerOptions のキー。 */
  optionKey: string;
};

/** 種別と id から spec を組み立てる。OpenAI 互換だけは id がキーになる。 */
export function providerSpec(kind: ProviderKind, id: string): ProviderSpec {
  return { id, kind, optionKey: kind === "openai-compatible" ? id : PROVIDER_KINDS[kind].optionKey };
}

/** ツールの結果に画像を置けるかどうか。 */
export function toolResultTakesImages(kind: ProviderKind): boolean {
  return PROVIDER_KINDS[kind].takesToolResultImages;
}

/**
 * models.dev の api を、接続先として使える形にする。
 * アカウント固有の値（${CLOUDFLARE_ACCOUNT_ID} など）が埋め込まれたものは解決できないので使わない。
 */
function usableApi(api: string | null): string | null {
  if (api === null) return null;

  const trimmed = api.trim().replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed.includes("${")) return null;
  return trimmed;
}

/** カタログのプロバイダ 1 件を、どのパッケージでどう呼ぶか。 */
export type CatalogRoute = {
  spec: ProviderSpec;
  /** null ならプロバイダパッケージの既定 URL を使う。 */
  baseUrl: string | null;
};

/**
 * カタログのプロバイダを、呼び出しに必要な形へ解決する。
 * 依存に無いパッケージのものと、接続先が分からない OpenAI 互換は null（選ばせない）。
 */
export function catalogRoute(input: { id: string; npm: string | null; api: string | null }): CatalogRoute | null {
  const kind = providerKindForNpm(input.npm);
  if (kind === null) return null;

  const baseUrl = usableApi(input.api);

  // openai 以外で @ai-sdk/openai を使うゲートウェイは、Responses API を持たないことが多い。
  // 実在の OpenAI 以外は OpenAI 互換（Chat Completions）として呼ぶ。
  if (kind === "openai" && input.id !== "openai") {
    if (baseUrl === null) return null;
    return { spec: providerSpec("openai-compatible", input.id), baseUrl };
  }

  // OpenAI 互換は接続先が無ければ何もできない。
  if (kind === "openai-compatible" && baseUrl === null) return null;

  return { spec: providerSpec(kind, input.id), baseUrl };
}

/**
 * プロバイダ id から spec を作る。画面が既定のモデルの選択肢を出すときに使う。
 * カタログに無い独自エンドポイントは OpenAI 互換として扱う。
 */
export function providerSpecForId(id: string, npm: string | null): ProviderSpec {
  const kind = providerKindForNpm(npm);
  if (kind === null || kind === "openai-compatible") return providerSpec("openai-compatible", id);
  return providerSpec(kind, id);
}

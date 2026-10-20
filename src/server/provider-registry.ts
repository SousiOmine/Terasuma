/**
 * モデルの呼び出しに使う AI SDK のプロバイダ。
 *
 * models.dev のプロバイダは、どの AI SDK パッケージで呼ぶか（npm）と、接続先（api）を持つ。
 * ここではその 2 つから、実際に使うパッケージと providerOptions のキーを決める。
 * 依存に持たないパッケージのプロバイダは選ばせない（呼べないものを一覧に混ぜない）。
 *
 * providerOptions のキーはパッケージごとに固定されている（anthropic は "anthropic"）。
 * OpenAI 互換だけは createOpenAICompatible に渡す name がキーになるので、プロバイダ id を使う。
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { modelParts, type ModelId } from "../shared/model";

/** 呼び出しに使う AI SDK のパッケージ。 */
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

/** モデル 1 件を呼ぶのに必要な、パッケージと providerOptions のキー。 */
export type ProviderSpec = {
  /** models.dev のプロバイダ id。 */
  id: string;
  kind: ProviderKind;
  /** providerOptions のキー。 */
  optionKey: string;
};

/** models.dev の npm → 使うパッケージ。ここに無いパッケージのプロバイダは扱わない。 */
const NPM_KINDS: Record<string, ProviderKind> = {
  "@ai-sdk/openai": "openai",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "google",
  "@ai-sdk/xai": "xai",
  "@ai-sdk/groq": "groq",
  "@ai-sdk/mistral": "mistral",
  "@ai-sdk/cerebras": "cerebras",
  "@ai-sdk/deepinfra": "deepinfra",
  "@ai-sdk/togetherai": "togetherai",
  "@ai-sdk/perplexity": "perplexity",
  "@ai-sdk/openai-compatible": "openai-compatible",
  "@openrouter/ai-sdk-provider": "openrouter",
};

/** パッケージごとの providerOptions のキー。OpenAI 互換は呼び出し側が id を入れる。 */
const OPTION_KEYS: Record<Exclude<ProviderKind, "openai-compatible">, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "xai",
  groq: "groq",
  mistral: "mistral",
  cerebras: "cerebras",
  deepinfra: "deepinfra",
  togetherai: "togetherai",
  perplexity: "perplexity",
  openrouter: "openrouter",
};

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
export function catalogRoute(input: {
  id: string;
  npm: string | null;
  api: string | null;
}): CatalogRoute | null {
  const kind = input.npm === null ? undefined : NPM_KINDS[input.npm];
  if (kind === undefined) return null;

  const baseUrl = usableApi(input.api);

  // openai 以外で @ai-sdk/openai を使うゲートウェイは、Responses API を持たないことが多い。
  // 実在の OpenAI 以外は OpenAI 互換（Chat Completions）として呼ぶ。
  if (kind === "openai" && input.id !== "openai") {
    if (baseUrl === null) return null;
    return { spec: { id: input.id, kind: "openai-compatible", optionKey: input.id }, baseUrl };
  }

  // OpenAI 互換は接続先が無ければ何もできない。
  if (kind === "openai-compatible" && baseUrl === null) return null;

  const spec: ProviderSpec =
    kind === "openai-compatible"
      ? { id: input.id, kind, optionKey: input.id }
      : { id: input.id, kind, optionKey: OPTION_KEYS[kind] };

  return { spec, baseUrl };
}

/** モデルを呼ぶのに必要な設定。 */
export type ResolvedModel = {
  /** "provider/model"。 */
  id: ModelId;
  /** 接続先。null ならプロバイダパッケージの既定 URL を使う。 */
  baseUrl: string | null;
  apiKey: string | null;
  /** 呼び出しに使うパッケージと providerOptions のキー。 */
  provider: ProviderSpec;
  reasoningEffort: string | null;
};

/**
 * 解決済みのモデルから、AI SDK のモデルを作る。
 * プロバイダ id ではなくモデル名だけを渡す（id の分解は modelParts に任せる）。
 */
export function createLanguageModel(model: ResolvedModel): LanguageModel {
  const { model: modelName } = modelParts(model.id);
  const apiKey = model.apiKey ?? undefined;
  const baseURL = model.baseUrl ?? undefined;

  switch (model.provider.kind) {
    case "openai":
      return createOpenAI({ apiKey, baseURL })(modelName);

    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(modelName);

    case "google":
      return createGoogle({ apiKey, baseURL })(modelName);

    case "xai":
      return createXai({ apiKey, baseURL })(modelName);

    case "groq":
      return createGroq({ apiKey, baseURL })(modelName);

    case "mistral":
      return createMistral({ apiKey, baseURL })(modelName);

    case "cerebras":
      return createCerebras({ apiKey, baseURL })(modelName);

    case "deepinfra":
      return createDeepInfra({ apiKey, baseURL })(modelName);

    case "togetherai":
      return createTogetherAI({ apiKey, baseURL })(modelName);

    case "perplexity":
      return createPerplexity({ apiKey, baseURL })(modelName);

    case "openrouter":
      return createOpenRouter({ apiKey, baseURL })(modelName);

    case "openai-compatible":
      if (baseURL === undefined) {
        throw new Error(`プロバイダ ${model.provider.optionKey} の接続先が分かりません`);
      }
      return createOpenAICompatible({
        name: model.provider.optionKey,
        baseURL,
        apiKey,
      }).chatModel(modelName);
  }
}

/**
 * プロバイダ id から、思考強度の渡し方を決めるための spec を作る。
 * 画面が既定のモデルの選択肢を出すときに使う。カタログに無い独自エンドポイントは OpenAI 互換。
 */
export function providerSpecForId(id: string, npm: string | null): ProviderSpec {
  const kind = npm === null ? undefined : NPM_KINDS[npm];
  if (kind === undefined || kind === "openai-compatible") {
    return { id, kind: "openai-compatible", optionKey: id };
  }
  return { id, kind, optionKey: OPTION_KEYS[kind] };
}

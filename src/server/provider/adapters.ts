/**
 * 解決済みのモデルから、AI SDK のモデルを作る。
 *
 * AI SDK のパッケージを import するのはこのファイルだけ。
 * カタログの読み取りや HTTP 層が、使わないプロバイダのパッケージまで読み込まないようにする。
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
import { modelParts } from "../../shared/model";
import type { ProviderKind } from "./kinds";
import type { ResolvedModel } from "./routing";

/** パッケージの生成に渡す値。 */
type AdapterOptions = {
  apiKey: string | undefined;
  baseURL: string | undefined;
  /** OpenAI 互換のときの providerOptions のキー（= プロバイダ id）。 */
  name: string;
};

/** 種別ごとの生成関数。表にしておき、種別を足したときの直し忘れを型で防ぐ。 */
const ADAPTERS: Record<ProviderKind, (options: AdapterOptions) => (modelName: string) => LanguageModel> = {
  openai: ({ apiKey, baseURL }) => createOpenAI({ apiKey, baseURL }),
  anthropic: ({ apiKey, baseURL }) => createAnthropic({ apiKey, baseURL }),
  google: ({ apiKey, baseURL }) => createGoogle({ apiKey, baseURL }),
  xai: ({ apiKey, baseURL }) => createXai({ apiKey, baseURL }),
  groq: ({ apiKey, baseURL }) => createGroq({ apiKey, baseURL }),
  mistral: ({ apiKey, baseURL }) => createMistral({ apiKey, baseURL }),
  cerebras: ({ apiKey, baseURL }) => createCerebras({ apiKey, baseURL }),
  deepinfra: ({ apiKey, baseURL }) => createDeepInfra({ apiKey, baseURL }),
  togetherai: ({ apiKey, baseURL }) => createTogetherAI({ apiKey, baseURL }),
  perplexity: ({ apiKey, baseURL }) => createPerplexity({ apiKey, baseURL }),
  openrouter: ({ apiKey, baseURL }) => createOpenRouter({ apiKey, baseURL }),
  "openai-compatible": ({ apiKey, baseURL, name }) => {
    if (baseURL === undefined) throw new Error(`プロバイダ ${name} の接続先が分かりません`);

    return createOpenAICompatible({
      name,
      baseURL,
      apiKey,
      // ツール結果の content を、テキストと画像の部品のまま送る。
      // 既定では画像も JSON 文字列に潰され、モデルが中身を読めない。
      supportsMultiPartToolContent: true,
    }).chatModel;
  },
};

/**
 * 解決済みのモデルから、AI SDK のモデルを作る。
 * プロバイダ id ではなくモデル名だけを渡す（id の分解は modelParts に任せる）。
 */
export function createLanguageModel(model: ResolvedModel): LanguageModel {
  const { model: modelName } = modelParts(model.id);
  const create = ADAPTERS[model.provider.kind];

  return create({
    apiKey: model.apiKey ?? undefined,
    baseURL: model.baseUrl ?? undefined,
    name: model.provider.optionKey,
  })(modelName);
}

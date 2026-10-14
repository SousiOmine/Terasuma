/**
 * 思考強度（reasoning effort）を、Mastra（AI SDK）へ渡す providerOptions に変換する。
 *
 * 渡し方はプロバイダごとに違う。
 * - ほとんどのプロバイダ（OpenAI 互換を含む）は reasoningEffort を受ける。キーは Mastra が
 *   createOpenAICompatible へ渡す名前、または組み込みのプロバイダ名と同じ。
 * - Anthropic は effort、Google は thinkingConfig.thinkingLevel を使う。
 *
 * 選択肢は「models.dev がそのモデルについて公開している値」と「AI SDK が受け付ける値」の交わりにする。
 * 交わりを取るのは、models.dev の値がそのまま AI SDK の型に無いことがあるため
 * （例: Anthropic の max は AI SDK 側の effort には無い）。
 */
import { effortValues, type CatalogModel } from "./models-dev";

/** providerOptions に入れられる値。Mastra（AI SDK）の型と同じ形にしてある。 */
export type ProviderOptionValue =
  | string
  | number
  | boolean
  | null
  | ProviderOptionValue[]
  | { [key: string]: ProviderOptionValue };

/** Mastra へ渡す providerOptions。プロバイダ id →（オプション名 → 値）。 */
export type ProviderOptions = Record<string, Record<string, ProviderOptionValue>>;

type Channel = {
  /** AI SDK が受け付ける値。 */
  values: readonly string[];
  build(effort: string): ProviderOptions;
};

/** reasoningEffort を受けるプロバイダの値（AI SDK のスキーマにあるもの）。 */
const REASONING_EFFORT_VALUES: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** reasoningEffort 以外の渡し方をするプロバイダ。 */
const CHANNELS: Record<string, Channel> = {
  anthropic: {
    values: ["low", "medium", "high", "xhigh"],
    build: (effort) => ({ anthropic: { effort } }),
  },
  google: {
    values: ["minimal", "low", "medium", "high"],
    build: (effort) => ({ google: { thinkingConfig: { thinkingLevel: effort } } }),
  },
};

/** 画面に出す選択肢。渡せる値だけに絞る。 */
export function selectableEfforts(providerId: string, model: CatalogModel | null): readonly string[] {
  const allowed = CHANNELS[providerId]?.values ?? REASONING_EFFORT_VALUES;
  return effortValues(model).filter((value) => allowed.includes(value));
}

/**
 * 保存された思考強度を providerOptions に変換する。
 * モデルに渡せない値が設定に入っていた場合は、黙って落とさず理由を添えて止める。
 */
export function reasoningProviderOptions(providerId: string, effort: string | null): ProviderOptions | null {
  if (effort === null) return null;

  const channel = CHANNELS[providerId];
  if (channel !== undefined) {
    if (!channel.values.includes(effort)) {
      throw new Error(`思考強度 ${effort} はプロバイダ ${providerId} に渡せません（設定で選び直してください）`);
    }
    return channel.build(effort);
  }

  if (!REASONING_EFFORT_VALUES.includes(effort)) {
    throw new Error(`思考強度 ${effort} はプロバイダ ${providerId} に渡せません（設定で選び直してください）`);
  }
  return { [providerId]: { reasoningEffort: effort } };
}

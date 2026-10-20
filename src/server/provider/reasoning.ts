/**
 * 思考強度（reasoning effort）を、AI SDK の providerOptions に変換する。
 *
 * 渡し方はプロバイダの種別ごとに違う。その事実は provider/kinds.ts の表が持ち、
 * ここは「どの値を受け付け、どう組み立てるか」だけを持つ。
 *
 * 選択肢は「models.dev がそのモデルについて公開している値」と「AI SDK が受け付ける値」の交わりにする。
 * providerOptions のキーは ProviderSpec.optionKey（パッケージが読む名前）に合わせる。
 */
import { effortValues, type CatalogModel } from "./catalog";
import { PROVIDER_KINDS, type ProviderSpec, type ReasoningStyle } from "./kinds";

/** providerOptions に入れられる値（AI SDK の型と同じ形）。 */
export type ProviderOptionValue =
  | string
  | number
  | boolean
  | null
  | ProviderOptionValue[]
  | { [key: string]: ProviderOptionValue };

/** プロバイダ id →（オプション名 → 値）。 */
export type ProviderOptions = Record<string, Record<string, ProviderOptionValue>>;

type Channel = {
  /** AI SDK が受け付ける値。 */
  values: readonly string[];
  build(effort: string, optionKey: string): ProviderOptions;
};

/** reasoningEffort を受けるプロバイダの値（AI SDK のスキーマにあるもの）。 */
const REASONING_EFFORT_VALUES: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 渡し方ごとの受け付ける値と組み立て方。 */
const CHANNELS: Record<ReasoningStyle, Channel> = {
  "reasoning-effort": {
    values: REASONING_EFFORT_VALUES,
    build: (effort, optionKey) => ({ [optionKey]: { reasoningEffort: effort } }),
  },
  "anthropic-effort": {
    values: ["low", "medium", "high", "xhigh", "max"],
    build: (effort, optionKey) => ({ [optionKey]: { effort } }),
  },
  "google-thinking": {
    values: ["minimal", "low", "medium", "high"],
    build: (effort, optionKey) => ({ [optionKey]: { thinkingConfig: { thinkingLevel: effort } } }),
  },
};

/** プロバイダの種別から、思考強度の渡し方を引く。 */
function channelOf(spec: ProviderSpec): Channel {
  return CHANNELS[PROVIDER_KINDS[spec.kind].reasoning];
}

/** 画面に出す選択肢。渡せる値だけに絞る。 */
export function selectableEfforts(spec: ProviderSpec, model: CatalogModel | null): readonly string[] {
  const allowed = channelOf(spec).values;
  return effortValues(model).filter((value) => allowed.includes(value));
}

/**
 * 保存された思考強度を providerOptions に変換する。
 * モデルに渡せない値が設定に入っていた場合は、黙って落とさず理由を添えて止める。
 */
export function reasoningProviderOptions(spec: ProviderSpec, effort: string | null): ProviderOptions | null {
  if (effort === null) return null;

  const channel = channelOf(spec);
  if (!channel.values.includes(effort)) {
    throw new Error(`思考強度 ${effort} はプロバイダ ${spec.id} に渡せません（設定で選び直してください）`);
  }
  return channel.build(effort, spec.optionKey);
}

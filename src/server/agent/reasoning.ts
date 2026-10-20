/**
 * 思考強度（reasoning effort）を、AI SDK の providerOptions に変換する。
 *
 * 渡し方はプロバイダのパッケージごとに違う。
 * - ほとんどのプロバイダ（OpenAI 互換を含む）は reasoningEffort を受ける。
 * - Anthropic は effort、Google は thinkingConfig.thinkingLevel を使う。
 *
 * 選択肢は「models.dev がそのモデルについて公開している値」と「AI SDK が受け付ける値」の交わりにする。
 * providerOptions のキーは ProviderSpec.optionKey（パッケージが読む名前）に合わせる。
 */
import { effortValues, type CatalogModel } from "../provider/catalog";
import type { ProviderKind, ProviderSpec } from "../provider/registry";

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

/** reasoningEffort 以外の渡し方をするプロバイダ。 */
const CHANNELS: Partial<Record<ProviderKind, Channel>> = {
  anthropic: {
    values: ["low", "medium", "high", "xhigh", "max"],
    build: (effort, optionKey) => ({ [optionKey]: { effort } }),
  },
  google: {
    values: ["minimal", "low", "medium", "high"],
    build: (effort, optionKey) => ({ [optionKey]: { thinkingConfig: { thinkingLevel: effort } } }),
  },
};

/** 画面に出す選択肢。渡せる値だけに絞る。 */
export function selectableEfforts(spec: ProviderSpec, model: CatalogModel | null): readonly string[] {
  const allowed = CHANNELS[spec.kind]?.values ?? REASONING_EFFORT_VALUES;
  return effortValues(model).filter((value) => allowed.includes(value));
}

/**
 * 保存された思考強度を providerOptions に変換する。
 * モデルに渡せない値が設定に入っていた場合は、黙って落とさず理由を添えて止める。
 */
export function reasoningProviderOptions(spec: ProviderSpec, effort: string | null): ProviderOptions | null {
  if (effort === null) return null;

  const channel = CHANNELS[spec.kind];
  if (channel !== undefined) {
    if (!channel.values.includes(effort)) {
      throw new Error(`思考強度 ${effort} はプロバイダ ${spec.id} に渡せません（設定で選び直してください）`);
    }
    return channel.build(effort, spec.optionKey);
  }

  if (!REASONING_EFFORT_VALUES.includes(effort)) {
    throw new Error(`思考強度 ${effort} はプロバイダ ${spec.id} に渡せません（設定で選び直してください）`);
  }
  return { [spec.optionKey]: { reasoningEffort: effort } };
}

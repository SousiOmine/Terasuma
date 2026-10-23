import {
  ENDPOINT_PRESETS,
  OPENAI_COMPATIBLE_TEMPLATE,
  findEndpointPreset,
  type EndpointPreset,
} from "../../../shared/providers";
import type { CatalogProviderView, ProviderView } from "../../../shared/api/settings";

/**
 * プロバイダ追加ウィザードの純粋な部分。
 *
 * 対象の決め方・選択肢の組み立て・id の採番は、表示から切り離してここに置く。
 * DOM もブラウザも要らないので、そのままテストできる。
 */

/** 追加・変更の対象。カタログのプロバイダか、接続先を自分で決めるエンドポイントか。 */
export type Target =
  | { kind: "catalog"; id: string; name: string }
  | { kind: "endpoint"; preset: EndpointPreset; id: string };

/**
 * 選択肢の 1 件。
 * カタログのプロバイダと、接続先を自分で決めるエンドポイント（Ollama など）を同じ並びに置く。
 */
export type ChooserEntry =
  | { kind: "catalog"; id: string; name: string; models: number }
  | { kind: "endpoint"; preset: EndpointPreset; id: string; name: string; models: null };

/** カタログの並び（名前順）に、接続先を自分で決めるものを混ぜる。 */
export function chooserEntries(
  catalog: readonly CatalogProviderView[] | null,
  nameOfPreset: (preset: EndpointPreset) => string,
): readonly ChooserEntry[] {
  const entries: ChooserEntry[] = [
    ...(catalog ?? []).map((provider) => ({
      kind: "catalog" as const,
      id: provider.id,
      name: provider.name,
      models: provider.models,
    })),
    ...ENDPOINT_PRESETS.map((preset) => ({
      kind: "endpoint" as const,
      preset,
      id: preset.id,
      name: nameOfPreset(preset),
      models: null,
    })),
  ];

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/** 設定済みのプロバイダから、変更フォームの対象を決める。 */
export function targetOf(provider: ProviderView): Target {
  if (provider.baseUrl === null) return { kind: "catalog", id: provider.id, name: provider.name };

  return {
    kind: "endpoint",
    preset: findEndpointPreset(provider.id) ?? OPENAI_COMPATIBLE_TEMPLATE,
    id: provider.id,
  };
}

/** 接続先を自分で決めるエンドポイントかどうか。 */
export function isEndpoint(provider: ProviderView): boolean {
  return provider.baseUrl !== null;
}

/** 追加する独自エンドポイントの id。設定済みと重ならない番号を選ぶ。 */
export function nextCustomEndpointId(used: readonly ProviderView[]): string {
  const ids = new Set(used.map((provider) => provider.id));
  for (let index = 1; ; index += 1) {
    const candidate = `custom-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

/** 一覧の中から最初に選ぶモデル。 */
export function pickModel(models: readonly string[]): string | null {
  return models[0] ?? null;
}

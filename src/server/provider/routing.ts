import { modelProvider, type ModelId } from "../../shared/model";
import type { ModelSettings } from "../data/settings-schema";
import { catalogProvider, type CatalogSnapshot } from "./catalog";
import { catalogRoute, type ProviderSpec } from "./kinds";

/**
 * 設定とカタログから、モデルの呼び出し方（URL・資格・パッケージ・思考強度）を決める。
 *
 * 設定が揃っていない状態は、モデルを呼ぶ前に理由付きで止める。
 * 既定値で埋め合わせると「設定したつもりで応答が来ない」状態になり、原因が分からなくなる。
 */

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

/** 呼び出せるかどうかの判定。呼び出せないときは理由を添える。 */
export type ModelResolution = { ok: true; model: ResolvedModel } | { ok: false; detail: string };

export function resolveModel(settings: ModelSettings, snapshot: CatalogSnapshot | null): ModelResolution {
  const model = settings.model;
  if (model === null) {
    return { ok: false, detail: "既定のモデルが設定されていません（画面の「設定 > モデル」から追加してください）" };
  }

  const providerId = modelProvider(model);
  const provider = settings.providers[providerId];
  if (provider === undefined) {
    return {
      ok: false,
      detail: `既定のモデル ${model} のプロバイダ ${providerId} が設定されていません（画面の「設定 > モデル」から追加してください）`,
    };
  }

  const reasoningEffort = settings.modelOptions[model]?.reasoningEffort ?? null;

  // baseUrl があるものは OpenAI 互換の独自エンドポイント。
  if (provider.baseUrl !== undefined) {
    return {
      ok: true,
      model: {
        id: model,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? null,
        provider: { id: providerId, kind: "openai-compatible", optionKey: providerId },
        reasoningEffort,
      },
    };
  }

  if (provider.apiKey === undefined) {
    return { ok: false, detail: `プロバイダ ${providerId} の API キーが設定されていません` };
  }

  if (snapshot === null) {
    return {
      ok: false,
      detail: "models.dev のカタログをまだ読めていません（少し待ってから、もう一度送ってください）",
    };
  }

  const entry = catalogProvider(snapshot, providerId);
  if (entry === null) {
    return {
      ok: false,
      detail: `プロバイダ ${providerId} を models.dev のカタログに見つけられません（画面の「設定 > モデル」から選び直してください）`,
    };
  }

  const route = catalogRoute(entry);
  if (route === null) {
    return {
      ok: false,
      detail: `プロバイダ ${providerId} をこのアプリから呼び出せません（対応していないか、接続先が分かりません。baseUrl を設定してください）`,
    };
  }

  return {
    ok: true,
    model: {
      id: model,
      baseUrl: route.baseUrl,
      apiKey: provider.apiKey,
      provider: route.spec,
      reasoningEffort,
    },
  };
}

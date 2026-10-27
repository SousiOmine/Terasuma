import { computed, signal } from "@preact/signals";
import { modelProvider, type ModelId } from "../../shared/model";
import type {
  AddProviderForm,
  ProviderCheckResult,
  ProviderCredentials,
  ProviderForm,
  ProviderView,
  ReasoningView,
} from "../../shared/api/settings";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";

/** 既定のモデルが使えない理由。 */
export type ModelProblem = "unset" | "provider-missing";

/** サーバから読んだモデル設定。まだ読めていないときは null。 */
export const modelResource = createResource(api.fetchModelSettings);
export const modelSettings = modelResource.data;
export const isLoadingSettings = modelResource.loading;
/** 設定を読めなかった理由。「読み込み中」と区別して画面に出す。 */
export const modelLoadError = modelResource.error;

/** 設定画面の中だけに出す失敗。チャット側のエラー表示とは分けてある。 */
const failure = createErrorSignal();
export const settingsError = failure.error;
export const showSettingsError = failure.show;
export const clearSettingsError = failure.clear;

/** models.dev のカタログ。まだ読めていないときは null。 */
export const catalogResource = createResource(api.fetchCatalog);
export const catalogProviders = catalogResource.data;
export const isLoadingCatalog = catalogResource.loading;
/** カタログを読めなかった理由。読めないとプロバイダを追加できないので、画面に出す。 */
export const catalogLoadError = catalogResource.error;

/**
 * 既定のモデルの思考強度。
 * 選べる値はカタログから来るので、カタログを読めていないときは null のままになる。
 */
export const modelReasoning = signal<ReasoningView | null>(null);

/** 設定済みのプロバイダ。 */
export const providers = computed<readonly ProviderView[]>(() => modelSettings.value?.providers ?? []);

/**
 * 既定のモデルが使えない理由。使えるなら null。
 * 設定をまだ読めていない間も null にして、読み込み前に警告を出さないようにする。
 */
export const modelProblem = computed<ModelProblem | null>(() => {
  const settings = modelSettings.value;
  if (settings === null) return null;

  if (settings.model === null) return "unset";

  const providerId = modelProvider(settings.model);
  return settings.providers.some((provider) => provider.id === providerId) ? null : "provider-missing";
});

/**
 * プロバイダの表示名。
 * 設定が持つのは利用者が付けた名前だけなので、カタログの名前を当ててから使う。
 */
export function providerName(provider: ProviderView): string {
  return catalogProviders.value?.find((entry) => entry.id === provider.id)?.name ?? provider.name;
}

/** 設定を読む（まだ読めていなければ）。失敗は呼び出し側が画面に出す。 */
export const loadModelSettings = modelResource.load;
/** 設定を読み直す（読み込み直しボタン）。 */
export const refreshModelSettings = modelResource.refresh;

/** カタログを読む（まだ読めていなければ）。 */
export const loadCatalog = catalogResource.load;
/** カタログを読み直す。 */

/** 既定のモデルの思考強度と、選べる値を読む。 */
export async function loadReasoning(): Promise<void> {
  modelReasoning.value = await api.fetchReasoning();
}

/**
 * 設定を書き換える操作。サーバが返した新しい全体をそのまま状態に置く。
 * 失敗は投げるので、ダイアログは手元に、設定画面は settingsError に出せる。
 */
export async function saveDefaultModel(model: ModelId): Promise<void> {
  modelSettings.value = await api.saveDefaultModel(model);
}

/**
 * 思考強度を変える。値はモデルごとに保存されるので、
 * 別のモデルへ切り替えて戻ると前の値が戻る。
 */
export async function saveReasoning(effort: string | null): Promise<void> {
  modelReasoning.value = await api.saveReasoning(effort);
}

/** 保存せずに、渡した資格でプロバイダへ繋がるか確かめる。 */
export async function checkProvider(form: ProviderForm): Promise<ProviderCheckResult> {
  return api.checkProvider(form);
}

/** カタログのプロバイダで使えるモデルの一覧。 */
export async function fetchCatalogModels(providerId: string): Promise<readonly string[]> {
  return api.fetchCatalogModels(providerId);
}

/** 設定済みのプロバイダで使えるモデルの一覧。 */
export async function listProviderModels(providerId: string): Promise<readonly string[]> {
  return api.listProviderModels(providerId);
}

export async function addProvider(form: AddProviderForm): Promise<void> {
  modelSettings.value = await api.addProvider(form);
}

export async function updateProvider(providerId: string, credentials: ProviderCredentials): Promise<void> {
  modelSettings.value = await api.updateProvider(providerId, credentials);
}

export async function removeProvider(providerId: string): Promise<void> {
  modelSettings.value = await api.deleteProvider(providerId);
}

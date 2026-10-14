import { computed, signal } from "@preact/signals";
import { modelProvider, type ModelId } from "../shared/model";
import type { AddProviderForm, ModelSettingsView, ProviderCredentials, ProviderView } from "../shared/types";
import * as api from "./api";
import { toErrorState, type ErrorState } from "./errors";

/** 既定のモデルが使えない理由。 */
export type ModelProblem = "unset" | "provider-missing";

/** サーバから読んだモデル設定。まだ読めていないときは null。 */
export const modelSettings = signal<ModelSettingsView | null>(null);
export const isLoadingSettings = signal(false);

/** 設定画面の中だけに出す失敗。チャット側のエラー表示とは分けてある。 */
export const settingsError = signal<ErrorState | null>(null);

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

/** 設定を読む。失敗は呼び出し側が画面に出す。 */
export async function loadModelSettings(): Promise<void> {
  isLoadingSettings.value = true;
  try {
    modelSettings.value = await api.fetchModelSettings();
  } finally {
    isLoadingSettings.value = false;
  }
}

/**
 * 設定を書き換える操作。サーバが返した新しい全体をそのまま状態に置く。
 * 失敗は投げるので、ダイアログは手元に、設定画面は settingsError に出せる。
 */
export async function saveDefaultModel(model: ModelId): Promise<void> {
  modelSettings.value = await api.saveDefaultModel(model);
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

export function showSettingsError(error: unknown): void {
  settingsError.value = toErrorState(error);
}

export function clearSettingsError(): void {
  settingsError.value = null;
}

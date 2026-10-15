import { computed, signal } from "@preact/signals";
import { modelProvider, type ModelId } from "../shared/model";
import type {
  AddProviderForm,
  CatalogProviderView,
  ModelSettingsView,
  ProviderCredentials,
  ProviderView,
  ReasoningView,
} from "../shared/types";
import * as api from "./api";
import { toErrorState, type ErrorState } from "./errors";

/** 既定のモデルが使えない理由。 */
export type ModelProblem = "unset" | "provider-missing";

/** サーバから読んだモデル設定。まだ読めていないときは null。 */
export const modelSettings = signal<ModelSettingsView | null>(null);
export const isLoadingSettings = signal(false);

/** 設定画面の中だけに出す失敗。チャット側のエラー表示とは分けてある。 */
export const settingsError = signal<ErrorState | null>(null);

/** models.dev のカタログ。まだ読めていないときは null。 */
export const catalogProviders = signal<readonly CatalogProviderView[] | null>(null);

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


/** 設定を読む。失敗は呼び出し側が画面に出す。 */
export async function loadModelSettings(): Promise<void> {
  isLoadingSettings.value = true;
  try {
    modelSettings.value = await api.fetchModelSettings();
  } finally {
    isLoadingSettings.value = false;
  }
}

/** カタログのプロバイダ一覧を読む。設定画面を開いたときに 1 度だけ読む。 */
export async function loadCatalog(): Promise<void> {
  catalogProviders.value = await api.fetchCatalog();
}

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

import { signal } from "@preact/signals";
import type { WebSearchProviderForm, WebSearchSettingsView } from "../../shared/types";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";

/**
 * Web 検索の設定。
 * 設定を変える API はすべて変えた後の全体を返すので、返ってきた値をそのまま置き直す。
 */

/** サーバーから読んだ Web 検索の設定。まだ読めていないときは null。 */
export const webSearchSettings = signal<WebSearchSettingsView | null>(null);
export const isLoadingWebSearch = signal(false);

/** Web 検索の画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const webSearchError = failure.error;
export const showWebSearchError = failure.show;
export const clearWebSearchError = failure.clear;

/** 設定画面を開いたときに読む。 */
export async function loadWebSearchSettings(): Promise<void> {
  isLoadingWebSearch.value = true;
  try {
    webSearchSettings.value = await api.fetchWebSearch();
  } finally {
    isLoadingWebSearch.value = false;
  }
}

/** 追加する。既定が未設定なら、追加したプロバイダが既定になる。 */
export async function addWebSearchProvider(form: WebSearchProviderForm): Promise<void> {
  webSearchSettings.value = await api.addWebSearchProvider(form);
}

/** 設定を変える。apiKey が null なら保存済みのキーを使う。 */
export async function updateWebSearchProvider(form: WebSearchProviderForm): Promise<void> {
  webSearchSettings.value = await api.updateWebSearchProvider(form);
}

/** 消す。既定だった場合は既定も未設定に戻る。 */
export async function removeWebSearchProvider(providerId: string): Promise<void> {
  webSearchSettings.value = await api.deleteWebSearchProvider(providerId);
}

/** 既定のプロバイダを変える。 */
export async function setDefaultWebSearchProvider(providerId: string): Promise<void> {
  webSearchSettings.value = await api.setDefaultWebSearchProvider(providerId);
}

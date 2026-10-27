import type { WebSearchProviderForm, WebSearchTestView } from "../../shared/api/settings";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";

/**
 * Web 検索の設定。
 * 設定を変える API はすべて変えた後の全体を返すので、返ってきた値をそのまま置き直す。
 */

/** サーバーから読んだ Web 検索の設定。まだ読めていないときは null。 */
export const webSearchResource = createResource(api.fetchWebSearch);
export const webSearchSettings = webSearchResource.data;
export const isLoadingWebSearch = webSearchResource.loading;
/** 設定を読めなかった理由。「読み込み中」と区別して画面に出す。 */
export const webSearchLoadError = webSearchResource.error;

/** Web 検索の画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const webSearchError = failure.error;
export const showWebSearchError = failure.show;
export const clearWebSearchError = failure.clear;

/** 保存する前に、入力されたキーで検索できるか確かめる。設定には書かない。 */
export async function testWebSearchProvider(form: WebSearchProviderForm): Promise<WebSearchTestView> {
  return api.testWebSearchProvider(form);
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

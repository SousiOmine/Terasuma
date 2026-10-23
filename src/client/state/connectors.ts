import { signal } from "@preact/signals";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";

/**
 * 設定 > コネクタ の状態。
 *
 * コネクタはトークンを貼るだけ。保存したら一覧を置き換える。
 * チャットのカードの待ちは、サーバーが setToken で解く。
 */

/** サーバーから読んだコネクタの一覧。まだ読めていないときは null。 */
const connectorsResource = createResource(api.fetchConnectors);
export const connectors = connectorsResource.data;
export const isLoadingConnectors = connectorsResource.loading;

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const connectorsError = failure.error;
export const showConnectorsError = failure.show;
export const clearConnectorsError = failure.clear;

/** トークンを保存しているコネクタ。操作中の表示に使う。 */
export const savingToken = signal<string | null>(null);

/** 設定画面を開いたときに読む（まだ読めていなければ）。 */
export const loadConnectors = connectorsResource.load;
/** 一覧を読み直す。 */
export const refreshConnectors = connectorsResource.refresh;

/** トークンを保存する。受け付けられなければ、サーバーが理由を返す。 */
export async function saveConnectorToken(id: string, token: string): Promise<void> {
  savingToken.value = id;
  try {
    connectors.value = await api.saveConnectorToken(id, token.trim());
  } finally {
    if (savingToken.value === id) savingToken.value = null;
  }
}

/** チャットのカードから、コネクタの待ちをやめる。 */
export async function cancelConnectorWait(id: string): Promise<void> {
  connectors.value = await api.cancelConnectorWait(id);
}

/** 保存されているトークンを消す。 */
export async function removeConnector(id: string): Promise<void> {
  connectors.value = await api.disconnectConnector(id);
}

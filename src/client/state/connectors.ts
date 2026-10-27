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
export const connectorsResource = createResource(api.fetchConnectors);
export const connectors = connectorsResource.data;
export const isLoadingConnectors = connectorsResource.loading;
/** 一覧を読めなかった理由。「読み込み中」と区別して画面に出す。 */
export const connectorsLoadError = connectorsResource.error;

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const connectorsError = failure.error;
export const showConnectorsError = failure.show;
export const clearConnectorsError = failure.clear;

/** トークンを保存しているコネクタ。操作中の表示に使う。 */
export const savingToken = signal<string | null>(null);

/** program コネクタを確かめている最中の id。操作中の表示に使う。 */
export const connecting = signal<string | null>(null);

/** トークンを保存する。受け付けられなければ、サーバーが理由を返す。 */
export async function saveConnectorToken(id: string, token: string): Promise<void> {
  savingToken.value = id;
  try {
    connectors.value = await api.saveConnectorToken(id, token.trim());
  } finally {
    if (savingToken.value === id) savingToken.value = null;
  }
}

/** program コネクタの設定を書いて確かめる。確かめられなければ、サーバーが理由を返す。 */
export async function connectConnector(id: string, input: api.ConnectorSetupInput = {}): Promise<void> {
  connecting.value = id;
  try {
    connectors.value = await api.connectConnector(id, input);
  } finally {
    if (connecting.value === id) connecting.value = null;
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

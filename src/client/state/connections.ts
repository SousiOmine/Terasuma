import { signal } from "@preact/signals";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";

/**
 * 設定 > 接続 の状態。
 *
 * 接続はトークンを貼るだけ。保存したら一覧を置き換える。
 * チャットの接続待ちは、サーバーが setToken で解く。
 */

/** サーバーから読んだ接続の一覧。まだ読めていないときは null。 */
const connectionsResource = createResource(api.fetchConnections);
export const connections = connectionsResource.data;
export const isLoadingConnections = connectionsResource.loading;

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const connectionsError = failure.error;
export const showConnectionsError = failure.show;
export const clearConnectionsError = failure.clear;

/** トークンを保存している接続。操作中の表示に使う。 */
export const savingToken = signal<string | null>(null);

/** 設定画面を開いたときに読む（まだ読めていなければ）。 */
export const loadConnections = connectionsResource.load;
/** 一覧を読み直す。 */
export const refreshConnections = connectionsResource.refresh;

/** トークンを保存する。受け付けられなければ、サーバーが理由を返す。 */
export async function saveConnectionToken(id: string, token: string): Promise<void> {
  savingToken.value = id;
  try {
    connections.value = await api.saveConnectionToken(id, token.trim());
  } finally {
    if (savingToken.value === id) savingToken.value = null;
  }
}

/** チャットのカードから、接続の待ちをやめる。 */
export async function cancelConnectionWait(id: string): Promise<void> {
  connections.value = await api.cancelConnectionWait(id);
}

/** 保存されているトークンを消す。 */
export async function removeConnection(id: string): Promise<void> {
  connections.value = await api.disconnectConnection(id);
}

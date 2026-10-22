import { signal } from "@preact/signals";
import type { ConnectionsView } from "../../shared/types";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";

/**
 * 設定 > 接続 の状態。
 *
 * 接続はトークンを貼るだけ。保存したら一覧を置き換える。
 * チャットの接続待ちは、サーバーが setToken で解く。
 */

/** サーバーから読んだ接続の一覧。まだ読めていないときは null。 */
export const connections = signal<ConnectionsView | null>(null);
export const isLoadingConnections = signal(false);

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const connectionsError = failure.error;
export const showConnectionsError = failure.show;
export const clearConnectionsError = failure.clear;

/** Application ID を保存している接続。操作中の表示に使う。 */
export const savingConnection = signal<string | null>(null);

/** トークンを保存している接続。操作中の表示に使う。 */
export const savingToken = signal<string | null>(null);

/** 設定画面を開いたときに読む。 */
export async function loadConnections(): Promise<void> {
  isLoadingConnections.value = true;
  try {
    connections.value = await api.fetchConnections();
  } finally {
    isLoadingConnections.value = false;
  }
}

/** Application ID を保存する。空文字は「消す」として null を送る。 */
export async function saveClientId(id: string, clientId: string): Promise<void> {
  savingConnection.value = id;
  try {
    connections.value = await api.saveConnectionClientId(id, clientId.trim().length === 0 ? null : clientId.trim());
  } finally {
    if (savingConnection.value === id) savingConnection.value = null;
  }
}

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

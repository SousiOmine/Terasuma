import { signal } from "@preact/signals";
import type { ConnectionFlowView, ConnectionsView } from "../../shared/types";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { pollUntil } from "../lib/polling";

/**
 * 設定 > 接続 の状態。
 *
 * 認可はブラウザの別タブで進むので、こちらからは状態を尋ねるしかない。
 * 尋ね続ける形は MCP の認可と同じ（polling.ts を共有する）。
 */

/** サーバーから読んだ接続の一覧。まだ読めていないときは null。 */
export const connections = signal<ConnectionsView | null>(null);
export const isLoadingConnections = signal(false);

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const connectionsError = failure.error;
export const showConnectionsError = failure.show;
export const clearConnectionsError = failure.clear;

/** Client ID を保存している接続。操作中の表示に使う。 */
export const savingConnection = signal<string | null>(null);

/** 認可を待っている接続と、そのコード。 */
export const authorizingConnection = signal<string | null>(null);
export const connectionFlow = signal<ConnectionFlowView | null>(null);

/** 認可を待つ間、状態を尋ねる間隔。 */
export const CONNECTION_POLL_MS = 2_000;

/** 認可を待つ上限。待ち続けて画面が固まったように見えるのを避ける。 */
export const CONNECTION_TIMEOUT_MS = 5 * 60 * 1_000;

/** 設定画面を開いたときに読む。 */
export async function loadConnections(): Promise<void> {
  isLoadingConnections.value = true;
  try {
    connections.value = await api.fetchConnections();
  } finally {
    isLoadingConnections.value = false;
  }
}

/** Client ID を保存する。空文字は「消す」として null を送る。 */
export async function saveClientId(id: string, clientId: string): Promise<void> {
  savingConnection.value = id;
  try {
    connections.value = await api.saveConnectionClientId(id, clientId.trim().length === 0 ? null : clientId.trim());
  } finally {
    if (savingConnection.value === id) savingConnection.value = null;
  }
}

/** 認可を始める。すでに接続済みなら null。 */
export async function startConnectionAuthorization(id: string): Promise<ConnectionFlowView | null> {
  // 二度押しで認可の要求が作り直されると、開いているコードが使えなくなる。待っている間は作り直さない。
  if (authorizingConnection.value === id) return connectionFlow.value;

  const result = await api.authorizeConnection(id);

  if (result.flow === null) {
    // 保存済みのトークンで足りた。読み直せば接続済みとして出る。
    await loadConnections();
    return null;
  }

  authorizingConnection.value = id;
  connectionFlow.value = result.flow;
  applyFlow(id, result.flow);
  void waitForAuthorization(id);
  return result.flow;
}

/** 待っている認可を取り消す。状態はサーバーが返したものに置き換える。 */
export async function cancelConnectionAuthorization(id: string): Promise<void> {
  connections.value = await api.cancelConnectionFlow(id);
  stopAuthorizing();
}

/** 保存されている認可を消す。 */
export async function removeConnection(id: string): Promise<void> {
  connections.value = await api.disconnectConnection(id);
  if (authorizingConnection.value === id) stopAuthorizing();
}

/**
 * 認可が終わるまで、一覧を読み直す。
 * 接続済みになるか、フローが消える（中止・期限切れ）まで続ける。
 */
async function waitForAuthorization(id: string): Promise<void> {
  const outcome = await pollUntil({
    intervalMs: CONNECTION_POLL_MS,
    timeoutMs: CONNECTION_TIMEOUT_MS,
    cancelled: () => authorizingConnection.value !== id,
    probe: () => api.fetchConnections(),
    done: (view) => {
      const provider = view.providers.find((entry) => entry.id === id);
      return provider === undefined || provider.account !== null || provider.flow === null;
    },
  });

  if (outcome.kind === "cancelled") return;

  if (outcome.kind === "value") {
    connections.value = outcome.value;
  } else if (outcome.kind === "error") {
    // 確かめられないまま繰り返しても進まないので、理由を出して止める。
    showConnectionsError(outcome.error);
  }

  stopAuthorizing();
}

function stopAuthorizing(): void {
  authorizingConnection.value = null;
  connectionFlow.value = null;
}

/** 一覧の中の 1 件だけを差し替える（認可を始めた直後にコードを出すため）。 */
function applyFlow(id: string, flow: ConnectionFlowView): void {
  const view = connections.value;
  if (view === null) return;

  connections.value = {
    providers: view.providers.map((provider) => (provider.id === id ? { ...provider, flow } : provider)),
  };
}

import { signal } from "@preact/signals";
import type { McpServerForm, McpServerStatusView, McpServersView } from "../shared/types";
import * as api from "./api";
import { toErrorState, type ErrorState } from "./errors";

/** サーバーから読んだ MCP サーバーの一覧。まだ読めていないときは null。 */
export const mcpServers = signal<McpServersView | null>(null);
export const isLoadingMcp = signal(false);

/** 詳細設定の中だけに出す失敗。 */
export const mcpError = signal<ErrorState | null>(null);

/** 接続を確認しているサーバー。操作中の表示に使う。 */
export const checkingServer = signal<string | null>(null);

/** 認可を待っているサーバーと、その認可画面の URL。 */
export const authorizingServer = signal<string | null>(null);
export const authorizationUrl = signal<string | null>(null);

/** 認可を待つ間、接続を確かめる間隔。 */
const AUTHORIZATION_POLL_MS = 2_000;

/** 認可を待つ上限。待ち続けて画面が固まったように見えるのを避ける。 */
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1_000;

/** 設定画面を開いたときに読む。 */
export async function loadMcpServers(): Promise<void> {
  isLoadingMcp.value = true;
  try {
    mcpServers.value = await api.fetchMcpServers();
  } finally {
    isLoadingMcp.value = false;
  }
}

/** 追加・変更。保存した後の全体が返るので、そのまま状態に置く。 */
export async function saveMcpServer(form: McpServerForm, mode: "add" | "edit"): Promise<void> {
  mcpServers.value = mode === "add" ? await api.addMcpServer(form) : await api.updateMcpServer(form);
}

export async function removeMcpServer(serverId: string): Promise<void> {
  mcpServers.value = await api.deleteMcpServer(serverId);
  if (authorizingServer.value === serverId) stopAuthorizing();
}

/** 接続を確かめ、結果を一覧へ反映する。 */
export async function checkServer(serverId: string): Promise<void> {
  checkingServer.value = serverId;
  try {
    applyStatus(serverId, await api.checkMcpServer(serverId));
  } finally {
    if (checkingServer.value === serverId) checkingServer.value = null;
  }
}

/**
 * 認可を始めて、開く URL を返す。すでに認可済みなら null。
 * 認可が終わるまでは接続を確かめ続け、終わり次第ツールの一覧が出る。
 */
export async function startAuthorization(serverId: string): Promise<string | null> {
  // 二度押しで認可の要求が作り直されると、開いている URL が使えなくなる。待っている間は作り直さない。
  if (authorizingServer.value === serverId) return authorizationUrl.value;

  const result = await api.authorizeMcpServer(serverId);

  if (result.url === null) {
    // 保存済みのトークンで足りた。繋ぎ直せば使える。
    await checkServer(serverId);
    return null;
  }

  authorizingServer.value = serverId;
  authorizationUrl.value = result.url;
  applyStatus(serverId, { state: "authorizing", tools: [], detail: null });
  void waitForAuthorization(serverId);
  return result.url;
}

/** 待っている認可を取り消す。状態は次の接続確認で置き換わる。 */
export async function cancelAuthorization(serverId: string): Promise<void> {
  mcpServers.value = await api.cancelMcpAuthorization(serverId);
  stopAuthorizing();
}

export function showMcpError(error: unknown): void {
  mcpError.value = toErrorState(error);
}

export function clearMcpError(): void {
  mcpError.value = null;
}

/**
 * 認可が終わるまで、接続を確かめる要求を繰り返す。
 * 認可はブラウザの別タブで進むため、こちらからは状態を尋ねるしかない。
 */
async function waitForAuthorization(serverId: string): Promise<void> {
  const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS;

  while (authorizingServer.value === serverId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, AUTHORIZATION_POLL_MS));
    if (authorizingServer.value !== serverId) return;

    try {
      const status = await api.checkMcpServer(serverId);
      applyStatus(serverId, status);
      if (status.state !== "authorizing") {
        stopAuthorizing();
        return;
      }
    } catch (error) {
      // 確かめられないまま繰り返しても進まないので、理由を出して止める。
      showMcpError(error);
      stopAuthorizing();
      return;
    }
  }

  if (authorizingServer.value === serverId) stopAuthorizing();
}

function stopAuthorizing(): void {
  authorizingServer.value = null;
  authorizationUrl.value = null;
}

/** 一覧の中の 1 件だけを差し替える（接続確認はその 1 件の結果しか返さないため）。 */
function applyStatus(serverId: string, status: McpServerStatusView): void {
  const view = mcpServers.value;
  if (view === null) return;

  mcpServers.value = {
    servers: view.servers.map((server) => (server.id === serverId ? { ...server, status } : server)),
  };
}

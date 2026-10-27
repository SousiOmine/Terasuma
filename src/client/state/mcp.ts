import { signal } from "@preact/signals";
import type { McpServerForm, McpServerStatusView, McpTestView } from "../../shared/api/settings";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";
import { pollUntil, type PollOutcome } from "../lib/polling";

/** サーバーから読んだ MCP サーバーの一覧。まだ読めていないときは null。 */
export const mcpServersResource = createResource(api.fetchMcpServers);
export const mcpServers = mcpServersResource.data;
export const isLoadingMcp = mcpServersResource.loading;
/** 一覧を読めなかった理由。「読み込み中」と区別して画面に出す。 */
export const mcpLoadError = mcpServersResource.error;

/** 詳細設定の中だけに出す失敗。 */
const failure = createErrorSignal();
export const mcpError = failure.error;
export const showMcpError = failure.show;
export const clearMcpError = failure.clear;

/** 接続を確認しているサーバー。操作中の表示に使う。 */
export const checkingServer = signal<string | null>(null);

/** 認可を待っているサーバーと、その認可画面の URL。 */
export const authorizingServer = signal<string | null>(null);
export const authorizationUrl = signal<string | null>(null);

/** 認可を待つ間、接続を確かめる間隔。 */
export const AUTHORIZATION_POLL_MS = 2_000;

/** 認可を待つ上限。待ち続けて画面が固まったように見えるのを避ける。 */
export const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1_000;

/** 設定画面を開いたときに読む（まだ読めていなければ）。 */
export const loadMcpServers = mcpServersResource.load;
/** 一覧を読み直す（読み込み中でも始め直す）。 */
export const refreshMcpServers = mcpServersResource.refresh;

/** 保存する前に、入力された設定で繋がるか確かめる。設定には書かない。 */
export async function testMcpServer(form: McpServerForm): Promise<McpTestView> {
  return api.testMcpServer(form);
}

/**
 * 保存前の確認で待っている認可をやめる。
 * ダイアログを閉じたときと、待ちがタイムアウトしたときに呼ぶ。
 */
export async function cancelMcpTest(serverId: string): Promise<void> {
  await api.cancelMcpTest(serverId);
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

/**
 * 保存前の確認で、認可が終わるまで尋ね続ける。
 * ダイアログは「待つ・尋ねる・終わりを見る」を書かず、ここへ委ねる。
 */
export async function waitForTestAuthorization(input: {
  form: McpServerForm;
  cancelled: () => boolean;
  onProbe: (status: McpTestView) => void;
}): Promise<PollOutcome<McpTestView>> {
  return pollUntil({
    intervalMs: AUTHORIZATION_POLL_MS,
    timeoutMs: AUTHORIZATION_TIMEOUT_MS,
    cancelled: input.cancelled,
    probe: () => testMcpServer(input.form),
    done: (status) => status.state !== "authorizing" && status.state !== "authorization_required",
    onProbe: input.onProbe,
  });
}

/**
 * 認可が終わるまで、接続を確かめる要求を繰り返す。
 * 認可はブラウザの別タブで進むため、こちらからは状態を尋ねるしかない。
 */
async function waitForAuthorization(serverId: string): Promise<void> {
  const outcome = await pollUntil({
    intervalMs: AUTHORIZATION_POLL_MS,
    timeoutMs: AUTHORIZATION_TIMEOUT_MS,
    cancelled: () => authorizingServer.value !== serverId,
    probe: () => api.checkMcpServer(serverId),
    done: (status) => status.state !== "authorizing",
  });

  if (outcome.kind === "cancelled") return;

  if (outcome.kind === "value") {
    applyStatus(serverId, outcome.value);
  } else if (outcome.kind === "error") {
    // 確かめられないまま繰り返しても進まないので、理由を出して止める。
    showMcpError(outcome.error);
  }

  stopAuthorizing();
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

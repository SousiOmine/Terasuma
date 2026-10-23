import type { ReplyLanguage } from "../../shared/language";
import type { ModelId } from "../../shared/model";
import { decodeChatEvents } from "../../shared/sse";
import type { ChatEvent, ChatMessageView, MessagePage, Tera } from "../../shared/api/message";
import type {
  AddProviderForm,
  CatalogProviderView,
  ComputerEnvView,
  ConnectionsView,
  ContainerStatusView,
  McpAuthorizationView,
  McpServerForm,
  McpServersView,
  McpServerStatusView,
  McpTestView,
  ModelSettingsView,
  ProviderCheckResult,
  ProviderCredentials,
  ProviderForm,
  ReasoningView,
  WebSearchProviderForm,
  WebSearchSettingsView,
  WebSearchTestView,
} from "../../shared/api/settings";

import { ApiError, fetchOrThrow, jsonRequest, request } from "./http";

export type { ClientErrorCode } from "./http";
export { ApiError } from "./http";

/** モデルとプロバイダの設定。 */
const MODEL_PATH = "/api/model";

/** MCP サーバーの設定。 */
const MCP_PATH = "/api/mcp/servers";

/** MCP サーバーを追加する前の接続確認。 */
const MCP_TEST_PATH = "/api/mcp/test";

/** アプリの接続（OAuth）。 */
const CONNECTIONS_PATH = "/api/connections";

/** Web 検索の設定。 */
const WEB_SEARCH_PATH = "/api/websearch";

/** podman で動かすコンテナ。 */
const CONTAINER_PATH = "/api/container";

/** 画面を渡している間の返事。 */
const HANDOVER_PATH = "/api/computer/handover";

/** コンピュータのコマンドへ渡す環境変数。 */
const COMPUTER_ENV_PATH = "/api/computer/env";

/** 画面に並べる Tera の一覧。 */
export async function listTeras(): Promise<readonly Tera[]> {
  const body = await request<{ teras: Tera[] }>("/api/teras");
  return body.teras;
}

/**
 * その Tera の履歴を 1 ページ読む（古い順）。
 * before は「この seq より前」を表し、null なら最新から読む。
 */
export async function listMessages(
  teraId: string,
  page: { limit: number; before: number | null },
): Promise<MessagePage> {
  const query = new URLSearchParams({ limit: String(page.limit) });
  if (page.before !== null) query.set("before", String(page.before));
  return request<MessagePage>(`${messagesPath(teraId)}?${query}`);
}

/**
 * 1 ターン分のイベントを SSE として受け取る。
 * 本文とファイルは multipart/form-data で送る。ファイルはサーバがコンテナへ置き、
 * そのパスをユーザー発言の後ろに添えてモデルへ渡す。
 * 画面へ流れるのは、モデルの本文・添付と、引き受けの出来事。
 * 途中で AbortSignal が立った場合は、例外にせずそのまま終了する（画面の切り替え）。
 */
export async function* streamTurn(
  teraId: string,
  content: string,
  language: ReplyLanguage,
  files: readonly File[],
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const form = messageForm(content, files);
  form.append("language", language);

  let response: Response;
  try {
    response = await fetchOrThrow(messagesPath(teraId), { method: "POST", body: form, signal });
  } catch (error) {
    // 利用者の「停止」は失敗ではないので、そのまま終わる。
    if (signal.aborted) return;
    throw error;
  }

  if (response.body === null) throw new ApiError("internal_error", "response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const { events, rest } = decodeChatEvents(buffer);
      buffer = rest;
      for (const event of events) yield event;
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 応答を生成しているターンの途中へ、発言を足す。
 * ターンがちょうど終わっていたら null（呼び出し側は、新しいターンとして送り直せる）。
 */
export async function steerTurn(
  teraId: string,
  content: string,
  files: readonly File[],
): Promise<ChatMessageView | null> {
  try {
    const body = await request<{ message: ChatMessageView }>(`${teraPath(teraId)}/steer`, {
      method: "POST",
      body: messageForm(content, files),
    });
    return body.message;
  } catch (error) {
    if (error instanceof ApiError && error.code === "turn_not_running") return null;
    throw error;
  }
}

/** 発言の multipart。送信と割り込みで同じ組み立てを使う。 */
function messageForm(content: string, files: readonly File[]): FormData {
  const form = new FormData();
  form.append("content", content);
  for (const file of files) form.append("files", file, file.name);
  return form;
}

/**
 * 走っているターンを止める。止めたターンは、それまでに書いた本文や添付を保存して
 * assistant-done を返す（SSE は閉じない）。
 */
export async function stopTurn(teraId: string): Promise<void> {
  await fetchOrThrow(`${teraPath(teraId)}/stop`, { method: "POST" });
}

function teraPath(teraId: string): string {
  return `/api/teras/${encodeURIComponent(teraId)}`;
}

function messagesPath(teraId: string): string {
  return `${teraPath(teraId)}/messages`;
}

/**
 * モデル設定の全体を読む。書き換える API も同じ形を返すので、
 * 画面は返ってきた値をそのまま状態に置き直せる。
 */
export async function fetchModelSettings(): Promise<ModelSettingsView> {
  return request<ModelSettingsView>(MODEL_PATH);
}

export async function saveDefaultModel(model: ModelId): Promise<ModelSettingsView> {
  return request<ModelSettingsView>(MODEL_PATH, jsonRequest("PUT", { model }));
}

/** 既定のモデルの思考強度と、選べる値。 */
export async function fetchReasoning(): Promise<ReasoningView> {
  return request<ReasoningView>(`${MODEL_PATH}/reasoning`);
}

/** 思考強度を null にすると未設定へ戻す。 */
export async function saveReasoning(reasoningEffort: string | null): Promise<ReasoningView> {
  return request<ReasoningView>(`${MODEL_PATH}/reasoning`, jsonRequest("PUT", { reasoningEffort }));
}

/** models.dev のカタログにあるプロバイダの一覧。 */
export async function fetchCatalog(): Promise<readonly CatalogProviderView[]> {
  const body = await request<{ providers: CatalogProviderView[] }>(`${MODEL_PATH}/catalog`);
  return body.providers;
}

/** カタログのプロバイダで使えるモデルの一覧。 */
export async function fetchCatalogModels(providerId: string): Promise<readonly string[]> {
  const body = await request<{ models: string[] }>(`${MODEL_PATH}/catalog/${encodeURIComponent(providerId)}/models`);
  return body.models;
}

/** 保存せずに接続だけを確かめる。確認する手段が無い場合は verified: false が返る。 */
export async function checkProvider(form: ProviderForm): Promise<ProviderCheckResult> {
  return request<ProviderCheckResult>(`${MODEL_PATH}/check`, jsonRequest("POST", form));
}

/**
 * 設定済みのプロバイダで使えるモデルの一覧。
 * カタログのプロバイダはカタログから、独自エンドポイントは /models から取る。
 */
export async function listProviderModels(providerId: string): Promise<readonly string[]> {
  const body = await request<{ models: string[] }>(`${providerPath(providerId)}/models`);
  return body.models;
}

export async function addProvider(form: AddProviderForm): Promise<ModelSettingsView> {
  return request<ModelSettingsView>(`${MODEL_PATH}/providers`, jsonRequest("POST", form));
}

/** apiKey に null を渡すと、保存済みのキーをそのまま使う。 */
export async function updateProvider(providerId: string, credentials: ProviderCredentials): Promise<ModelSettingsView> {
  return request<ModelSettingsView>(providerPath(providerId), jsonRequest("PATCH", credentials));
}

export async function deleteProvider(providerId: string): Promise<ModelSettingsView> {
  return request<ModelSettingsView>(providerPath(providerId), { method: "DELETE" });
}

function providerPath(providerId: string): string {
  return `${MODEL_PATH}/providers/${encodeURIComponent(providerId)}`;
}

/** MCP サーバーの一覧（設定と、いま分かっている接続状態）。 */
export async function fetchMcpServers(): Promise<McpServersView> {
  return request<McpServersView>(MCP_PATH);
}

export async function addMcpServer(form: McpServerForm): Promise<McpServersView> {
  return request<McpServersView>(MCP_PATH, jsonRequest("POST", form));
}

export async function updateMcpServer(form: McpServerForm): Promise<McpServersView> {
  return request<McpServersView>(mcpServerPath(form.id), jsonRequest("PATCH", form));
}

export async function deleteMcpServer(serverId: string): Promise<McpServersView> {
  return request<McpServersView>(mcpServerPath(serverId), { method: "DELETE" });
}

/** 接続を確かめ、公開されているツールを取り直す。 */
export async function checkMcpServer(serverId: string): Promise<McpServerStatusView> {
  return request<McpServerStatusView>(`${mcpServerPath(serverId)}/check`, { method: "POST" });
}

/** 追加の前に、入力された設定で繋がるかを確かめる。サーバーが認可を求めれば、開く URL が返る。 */
export async function testMcpServer(form: McpServerForm): Promise<McpTestView> {
  return request<McpTestView>(MCP_TEST_PATH, jsonRequest("POST", form));
}

/** OAuth の認可を始める。開く URL が返る（すでに認可済みなら null）。 */
export async function authorizeMcpServer(serverId: string): Promise<McpAuthorizationView> {
  return request<McpAuthorizationView>(`${mcpServerPath(serverId)}/authorize`, { method: "POST" });
}

/** 待っている認可を取り消す。 */
export async function cancelMcpAuthorization(serverId: string): Promise<McpServersView> {
  return request<McpServersView>(`${mcpServerPath(serverId)}/authorize`, { method: "DELETE" });
}

function mcpServerPath(serverId: string): string {
  return `${MCP_PATH}/${encodeURIComponent(serverId)}`;
}

/** アプリの接続の一覧（Application ID の設定と、接続中のアカウント）。 */
export async function fetchConnections(): Promise<ConnectionsView> {
  return request<ConnectionsView>(CONNECTIONS_PATH);
}

/** Application ID を保存する。null で設定ごと消す。 */
export async function saveConnectionClientId(id: string, clientId: string | null): Promise<ConnectionsView> {
  return request<ConnectionsView>(connectionPath(id), jsonRequest("PUT", { clientId }));
}

/** トークンを保存する。保存する前に、サーバーがトークンでアカウントを確かめる。 */
export async function saveConnectionToken(id: string, token: string): Promise<ConnectionsView> {
  return request<ConnectionsView>(`${connectionPath(id)}/token`, jsonRequest("PUT", { token }));
}

/** 接続の待ちをやめる（チャットのカード）。 */
export async function cancelConnectionWait(id: string): Promise<ConnectionsView> {
  return request<ConnectionsView>(`${connectionPath(id)}/wait`, { method: "DELETE" });
}

/** 保存されているトークンを消す。 */
export async function disconnectConnection(id: string): Promise<ConnectionsView> {
  return request<ConnectionsView>(connectionPath(id), { method: "DELETE" });
}

function connectionPath(id: string): string {
  return `${CONNECTIONS_PATH}/${encodeURIComponent(id)}`;
}

/** Web 検索の設定（既定のプロバイダと、登録済みのプロバイダ）。 */
export async function fetchWebSearch(): Promise<WebSearchSettingsView> {
  return request<WebSearchSettingsView>(WEB_SEARCH_PATH);
}

/** 検索プロバイダを追加する。保存した後の全体が返る。 */
export async function addWebSearchProvider(form: WebSearchProviderForm): Promise<WebSearchSettingsView> {
  return request<WebSearchSettingsView>(`${WEB_SEARCH_PATH}/providers`, jsonRequest("POST", form));
}

/** 検索プロバイダの設定を変える。apiKey が null なら保存済みのキーを使う。 */
export async function updateWebSearchProvider(form: WebSearchProviderForm): Promise<WebSearchSettingsView> {
  return request<WebSearchSettingsView>(webSearchProviderPath(form.id), jsonRequest("PATCH", form));
}

/** 検索プロバイダを消す。既定だった場合は既定も未設定に戻る。 */
export async function deleteWebSearchProvider(providerId: string): Promise<WebSearchSettingsView> {
  return request<WebSearchSettingsView>(webSearchProviderPath(providerId), { method: "DELETE" });
}

/** 既定の検索プロバイダを変える。null で未設定に戻す。 */
export async function setDefaultWebSearchProvider(providerId: string | null): Promise<WebSearchSettingsView> {
  return request<WebSearchSettingsView>(`${WEB_SEARCH_PATH}/default`, jsonRequest("PUT", { id: providerId }));
}

/** 保存の前に、入力された API キーで検索できるかを確かめる。設定には何も書かない。 */
export async function testWebSearchProvider(form: WebSearchProviderForm): Promise<WebSearchTestView> {
  return request<WebSearchTestView>(`${WEB_SEARCH_PATH}/test`, jsonRequest("POST", form));
}

function webSearchProviderPath(providerId: string): string {
  return `${WEB_SEARCH_PATH}/providers/${encodeURIComponent(providerId)}`;
}

/**
 * 引き受け中の返事を届ける。チャットに書いた文か、「操作を完了した」のどちらか。
 * どちらも computer_ask_user の戻り値になる。
 */
export async function answerHandover(
  teraId: string,
  answer: { kind: "done" } | { kind: "text"; text: string },
): Promise<void> {
  await fetchOrThrow(HANDOVER_PATH, jsonRequest("POST", { teraId, ...answer }));
}

/**
 * 待っている環境変数の入力。値を送るか、入力をやめるか。
 * 値はここからサーバへ直接渡り、会話（SSE・履歴）には載らない。
 */
export async function answerEnvRequest(
  teraId: string,
  answer: { kind: "value"; name: string; value: string } | { kind: "cancel"; name: string },
): Promise<void> {
  await fetchOrThrow(`${COMPUTER_ENV_PATH}/answer`, jsonRequest("POST", { teraId, ...answer }));
}

/** 設定されている環境変数の名前。値は返らない。 */
export async function fetchComputerEnv(): Promise<readonly string[]> {
  const body = await request<ComputerEnvView>(COMPUTER_ENV_PATH);
  return body.variables;
}

/** 環境変数を消す。残っている名前の一覧が返る。 */
export async function deleteComputerEnv(name: string): Promise<readonly string[]> {
  const body = await request<ComputerEnvView>(`${COMPUTER_ENV_PATH}/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  return body.variables;
}

/** コンテナのいまの状態（podman に問い合わせた結果）。 */
export async function fetchContainer(): Promise<ContainerStatusView> {
  return request<ContainerStatusView>(CONTAINER_PATH);
}

/** コンテナを起動する。イメージが無ければ作り、コンテナが無ければ作るところまで行う。 */
export async function startContainer(): Promise<ContainerStatusView> {
  return request<ContainerStatusView>(`${CONTAINER_PATH}/start`, { method: "POST" });
}

/** コンテナを作り直す。ホームの中身も消すかどうかを選べる。 */
export async function resetContainer(wipeHome: boolean): Promise<ContainerStatusView> {
  return request<ContainerStatusView>(`${CONTAINER_PATH}/reset`, jsonRequest("POST", { wipeHome }));
}

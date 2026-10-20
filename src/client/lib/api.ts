import type { ReplyLanguage } from "../../shared/language";
import type { ModelId } from "../../shared/model";
import { decodeChatEvents } from "../../shared/sse";
import type {
  AddProviderForm,
  CatalogProviderView,
  ChatEvent,
  ChatMessage,
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
  Tera,
} from "../../shared/types";

import { ApiError, fetchOrThrow, jsonRequest, request } from "./http";

export type { ClientErrorCode } from "./http";
export { ApiError } from "./http";

/** モデルとプロバイダの設定。 */
const MODEL_PATH = "/api/model";

/** MCP サーバーの設定。 */
const MCP_PATH = "/api/mcp/servers";

/** MCP サーバーを追加する前の接続確認。 */
const MCP_TEST_PATH = "/api/mcp/test";

/** podman で動かすコンテナ。 */
const CONTAINER_PATH = "/api/container";

/** 画面を渡している間の返事。 */
const HANDOVER_PATH = "/api/computer/handover";

/** 画面に並べる Tera の一覧。 */
export async function listTeras(): Promise<readonly Tera[]> {
  const body = await request<{ teras: Tera[] }>("/api/teras");
  return body.teras;
}

/** その Tera の履歴（古い順）。 */
export async function listMessages(teraId: string): Promise<readonly ChatMessage[]> {
  const body = await request<{ messages: ChatMessage[] }>(messagesPath(teraId));
  return body.messages;
}

/**
 * 1 ターン分のイベントを SSE として受け取る。
 * 途中で AbortSignal が立った場合は、例外にせずそのまま終了する（利用者の「停止」操作）。
 */
export async function* streamTurn(
  teraId: string,
  content: string,
  language: ReplyLanguage,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  let response: Response;
  try {
    response = await fetchOrThrow(messagesPath(teraId), jsonRequest("POST", { content, language }, signal));
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

import type { ReplyLanguage } from "../../shared/language";
import type { DiscordWebhooksView } from "../../shared/api/discord";
import { CLIENT_HEADER, type ConversationEvent } from "../../shared/api/events";
import type { ModelId } from "../../shared/model";
import { decodeChatEvents, decodeConversationEvents } from "../../shared/sse";
import type { ChatEvent, ChatMessageView, MessagePage, Tera } from "../../shared/api/message";
import type {
  AddProviderForm,
  CatalogProviderView,
  ComputerEnvView,
  ConnectorsView,
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

/** モデルとプロバイダの設定。 */
const MODEL_PATH = "/api/model";

/** MCP サーバーの設定。 */
const MCP_PATH = "/api/mcp/servers";

/** MCP サーバーを追加する前の接続確認。 */
const MCP_TEST_PATH = "/api/mcp/test";

/** コネクタ（トークン）。 */
const CONNECTORS_PATH = "/api/connectors";

/** Discord の webhook（Tera ごと）。 */
const DISCORD_PATH = "/api/discord";

/** Web 検索の設定。 */
const WEB_SEARCH_PATH = "/api/websearch";

/** podman で動かすコンテナ。 */
const CONTAINER_PATH = "/api/container";

/** 画面を渡している間の返事。 */
const HANDOVER_PATH = "/api/computer/handover";

/** コンピュータのコマンドへ渡す環境変数。 */
const COMPUTER_ENV_PATH = "/api/computer/env";

/**
 * この画面（タブ）の id。読み込みごとに作り、会話の要求すべてに付ける。
 * サーバは、この画面が購読している流れへ、この画面の送信を二重に流さない。
 *
 * crypto.randomUUID は安全な接続（HTTPS か localhost）でしか使えないため、
 * 画面を見分けるだけのこの値は、どこでも使える getRandomValues で作る。
 */
const clientId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");

/** この画面の id を添えたヘッダ。 */
function clientHeaders(): HeadersInit {
  return { [CLIENT_HEADER]: clientId };
}

/** 画面に並べる Tera の一覧。 */
export async function listTeras(): Promise<readonly Tera[]> {
  const body = await request<{ teras: Tera[] }>("/api/teras");
  return body.teras;
}

/**
 * Tera を消す。履歴・identity・Discord の webhook・作業フォルダもサーバ側で消える。
 * 消したあとの一覧が返る（最後の 1 体だったときは、作り直された既定の Tera が入っている）。
 */
export async function deleteTera(teraId: string): Promise<readonly Tera[]> {
  const body = await request<{ teras: Tera[] }>(teraPath(teraId), { method: "DELETE" });
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
    response = await fetchOrThrow(messagesPath(teraId), {
      method: "POST",
      body: form,
      headers: clientHeaders(),
      signal,
    });
  } catch (error) {
    // 利用者の「停止」は失敗ではないので、そのまま終わる。
    if (signal.aborted) return;
    throw error;
  }

  yield* readEvents(response, decodeChatEvents, signal);
}

/**
 * 最後のユーザー発言へ、発言を増やさずにもう一度答えてもらう。
 * 応答の終わりを受け取れなかったときのやり直しに使う。読み方は送信と同じ。
 */
export async function* retryTurn(
  teraId: string,
  language: ReplyLanguage,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const form = new FormData();
  form.append("language", language);

  let response: Response;
  try {
    response = await fetchOrThrow(`${teraPath(teraId)}/retry`, {
      method: "POST",
      body: form,
      headers: clientHeaders(),
      signal,
    });
  } catch (error) {
    // 利用者の「停止」や画面の切り替えは失敗ではないので、そのまま終わる。
    if (signal.aborted) return;
    throw error;
  }

  yield* readEvents(response, decodeChatEvents, signal);
}

/**
 * その Tera の出来事の購読。同じ Tera を開いているほかの画面で起きたターンの内容も、
 * ここからそのまま流れてくる。最初に sync が 1 つ届く（いまの連番と、ターンが走っているか）。
 * 途中で AbortSignal が立った場合は、例外にせずそのまま終了する（画面の切り替え）。
 */
export async function* streamConversation(teraId: string, signal: AbortSignal): AsyncGenerator<ConversationEvent> {
  let response: Response;
  try {
    response = await fetchOrThrow(`${teraPath(teraId)}/events`, { headers: clientHeaders(), signal });
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }

  yield* readEvents(response, decodeConversationEvents, signal);
}

/** SSE の応答を、イベントへ戻しながら順に返す。送信の応答と購読で同じ読み方をする。 */
async function* readEvents<T>(
  response: Response,
  decode: (buffer: string) => { events: T[]; rest: string },
  signal: AbortSignal,
): AsyncGenerator<T> {
  if (response.body === null) throw new ApiError("internal_error", "response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const { events, rest } = decode(buffer);
      buffer = rest;
      for (const event of events) yield event;
    }
  } catch (error) {
    // 利用者の「停止」や画面の切り替えは失敗ではないので、そのまま終わる。
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
      headers: clientHeaders(),
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

/** コネクタの一覧（接続中のアカウント）。 */
export async function fetchConnectors(): Promise<ConnectorsView> {
  return request<ConnectorsView>(CONNECTORS_PATH);
}

/** トークンを保存する。保存する前に、サーバーがトークンでアカウントを確かめる。 */
export async function saveConnectorToken(id: string, token: string): Promise<ConnectorsView> {
  return request<ConnectorsView>(`${connectorPath(id)}/token`, jsonRequest("PUT", { token }));
}

/** program コネクタの設定。キーが無ければ、いまの設定を確かめるだけ。 */
export type ConnectorSetupInput = { provider?: string; apiKey?: string; model?: string };

/** program コネクタ（コンピュータの中のプログラム）の設定を書いて確かめる。 */
export async function connectConnector(id: string, input: ConnectorSetupInput = {}): Promise<ConnectorsView> {
  const body: ConnectorSetupInput = {};
  if (input.provider !== undefined) body.provider = input.provider;
  if (input.apiKey !== undefined) body.apiKey = input.apiKey;
  if (input.model !== undefined) body.model = input.model;

  return request<ConnectorsView>(`${connectorPath(id)}/connect`, jsonRequest("POST", body));
}

/** コネクタの待ちをやめる（チャットのカード）。 */
export async function cancelConnectorWait(id: string): Promise<ConnectorsView> {
  return request<ConnectorsView>(`${connectorPath(id)}/wait`, { method: "DELETE" });
}

/** 保存されているトークンを消す。 */
export async function disconnectConnector(id: string): Promise<ConnectorsView> {
  return request<ConnectorsView>(connectorPath(id), { method: "DELETE" });
}

function connectorPath(id: string): string {
  return `${CONNECTORS_PATH}/${encodeURIComponent(id)}`;
}

/** Discord の webhook（Tera ごとの状態）。 */
export async function fetchDiscord(): Promise<DiscordWebhooksView> {
  return request<DiscordWebhooksView>(DISCORD_PATH);
}

/** Tera の webhook URL を保存する。保存する前に、サーバーが webhook を確かめる。 */
export async function saveDiscordWebhook(teraId: string, url: string): Promise<DiscordWebhooksView> {
  return request<DiscordWebhooksView>(discordPath(teraId), jsonRequest("PUT", { url }));
}

/** Tera の webhook を消す。 */
export async function clearDiscordWebhook(teraId: string): Promise<DiscordWebhooksView> {
  return request<DiscordWebhooksView>(discordPath(teraId), { method: "DELETE" });
}

/** Discord の webhook の待ちをやめる（チャットのカード）。 */
export async function cancelDiscordWait(teraId: string): Promise<DiscordWebhooksView> {
  return request<DiscordWebhooksView>(`${discordPath(teraId)}/wait`, { method: "DELETE" });
}

function discordPath(teraId: string): string {
  return `${DISCORD_PATH}/${encodeURIComponent(teraId)}`;
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

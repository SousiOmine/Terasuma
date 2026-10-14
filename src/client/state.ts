import { computed, signal } from "@preact/signals";
import type { ChatEvent, ChatMessage, Session } from "../shared/types";
import * as api from "./api";
import { toErrorState } from "./errors";
import { locale, setLocale } from "./i18n";
import { loadModelSettings } from "./modelSettings";

export type ClientErrorCode = api.ClientErrorCode;

/** 表示中の画面。設定は全画面で開く。 */
export type View = "chat" | "settings";

/** 設定画面のカテゴリ。導線から特定のカテゴリを直接開くために signal で持つ。 */
export type SettingsCategory = "general" | "model";

export const view = signal<View>("chat");
export const settingsCategory = signal<SettingsCategory>("general");
export const sessions = signal<readonly Session[]>([]);
export const activeSessionId = signal<string | null>(null);
export const messages = signal<readonly ChatMessage[]>([]);
export const streamingText = signal("");
export const isStreaming = signal(false);
export const isLoadingMessages = signal(false);
export const errorCode = signal<ClientErrorCode | null>(null);
export const errorDetail = signal<string | null>(null);

/** 一覧にまだ載っていない新規セッションでは null になる（その場合は「新しいチャット」と表示する）。 */
export const activeSession = computed(
  () => sessions.value.find((session) => session.id === activeSessionId.value) ?? null,
);

/** 削除の確認ダイアログが対象にしている会話の id。null ならダイアログは閉じている。 */
const pendingDeleteSessionId = signal<string | null>(null);

/** 確認ダイアログに出す会話。一覧から消えた id なら null になり、ダイアログも閉じる。 */
export const pendingDeleteSession = computed(
  () => sessions.value.find((session) => session.id === pendingDeleteSessionId.value) ?? null,
);

let controller: AbortController | null = null;

export async function bootstrap(): Promise<void> {
  setLocale(locale.value);

  try {
    // モデル設定は、チャット画面の「使うモデルがありません」の案内にも使う。
    await loadModelSettings();
    await refreshSessions();
    const latest = sessions.value[0];
    if (latest === undefined) {
      startNewChat();
    } else {
      await openSession(latest.id);
    }
  } catch (error) {
    // サーバに繋がらない場合も、入力できる画面は出しておく（送信時にあらためて失敗を伝える）。
    reportError(error);
    startNewChat();
  }
}

export async function refreshSessions(): Promise<void> {
  sessions.value = await api.listSessions();
}

export function startNewChat(): void {
  stopStreaming();
  clearError();
  // セッション行はサーバ側で最初の送信時に作られる。ここでは id だけ先に決めておく。
  activeSessionId.value = crypto.randomUUID();
  messages.value = [];
  streamingText.value = "";
}

export async function openSession(id: string): Promise<void> {
  stopStreaming();
  clearError();
  activeSessionId.value = id;
  isLoadingMessages.value = true;
  try {
    messages.value = await api.listMessages(id);
  } finally {
    isLoadingMessages.value = false;
  }
}

export async function sendMessage(rawContent: string): Promise<void> {
  const content = rawContent.trim();
  if (content.length === 0 || isStreaming.value) return;

  const sessionId = activeSessionId.value ?? crypto.randomUUID();
  activeSessionId.value = sessionId;
  clearError();

  const abort = new AbortController();
  controller = abort;
  isStreaming.value = true;
  streamingText.value = "";

  try {
    for await (const event of api.streamTurn(sessionId, content, abort.signal)) {
      applyEvent(event);
    }
  } catch (error) {
    reportError(error);
  } finally {
    isStreaming.value = false;
    streamingText.value = "";
    controller = null;
  }

  // タイトルはサーバが最初の発言から決めるので一覧を取り直す。
  // 会話自体は成立しているため、ここでの失敗は画面に出さない。
  try {
    await refreshSessions();
  } catch {
    // 一覧が古いままでも会話は続けられる。
  }
}

export function stopStreaming(): void {
  controller?.abort();
  controller = null;
}

/** 削除の確認ダイアログを開く。削除そのものは confirmDeleteSession で行う。 */
export function requestDeleteSession(id: string): void {
  pendingDeleteSessionId.value = id;
}

/** 削除の確認ダイアログを閉じる。 */
export function cancelDeleteSession(): void {
  pendingDeleteSessionId.value = null;
}

/** 確認ダイアログで「削除する」を選んだときの削除実行。 */
export async function confirmDeleteSession(): Promise<void> {
  const target = pendingDeleteSession.value;
  if (target === null) return;

  // 削除の成否にかかわらずダイアログは閉じる。失敗は reportError が画面に出す。
  cancelDeleteSession();
  await removeSession(target.id);
}

async function removeSession(id: string): Promise<void> {
  try {
    await api.deleteSession(id);
    await refreshSessions();

    if (activeSessionId.value !== id) return;

    const latest = sessions.value[0];
    if (latest === undefined) startNewChat();
    else await openSession(latest.id);
  } catch (error) {
    reportError(error);
  }
}

export function clearError(): void {
  errorCode.value = null;
  errorDetail.value = null;
}

/** 設定画面を開く。導線に合わせて、開くカテゴリを指定できる。 */
export function openSettings(category: SettingsCategory = "general"): void {
  settingsCategory.value = category;
  view.value = "settings";
}

export function closeSettings(): void {
  view.value = "chat";
}

function applyEvent(event: ChatEvent): void {
  switch (event.type) {
    case "user-message":
      messages.value = [...messages.value, event.message];
      break;
    case "assistant-start":
      streamingText.value = "";
      break;
    case "text-delta":
      streamingText.value += event.delta;
      break;
    case "assistant-done":
      messages.value = [...messages.value, event.message];
      streamingText.value = "";
      break;
    case "error":
      errorCode.value = event.code;
      errorDetail.value = event.detail;
      break;
  }
}

function reportError(error: unknown): void {
  const state = toErrorState(error);
  errorCode.value = state.code;
  errorDetail.value = state.detail;
}

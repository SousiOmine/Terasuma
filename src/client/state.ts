import { computed, signal } from "@preact/signals";
import type { ChatEvent, ChatMessage, Session } from "../shared/types";
import * as api from "./api";
import { locale, setLocale } from "./i18n";

export type ClientErrorCode = api.ClientErrorCode;

/** 表示中の画面。設定は全画面で開く。 */
export type View = "chat" | "settings";

export const view = signal<View>("chat");
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

let controller: AbortController | null = null;

export async function bootstrap(): Promise<void> {
  setLocale(locale.value);

  try {
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

export async function removeSession(id: string): Promise<void> {
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

export async function renameSession(id: string, title: string): Promise<void> {
  try {
    await api.renameSession(id, title);
    await refreshSessions();
  } catch (error) {
    reportError(error);
  }
}

export function clearError(): void {
  errorCode.value = null;
  errorDetail.value = null;
}

export function openSettings(): void {
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
  if (error instanceof api.ApiError) {
    errorCode.value = error.code;
    errorDetail.value = error.detail;
    return;
  }

  errorCode.value = "internal_error";
  errorDetail.value = error instanceof Error ? error.message : String(error);
}

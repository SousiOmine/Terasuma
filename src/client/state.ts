import { computed, signal } from "@preact/signals";
import type { ChatEvent, ChatMessage, Session } from "../shared/types";
import * as api from "./api";
import { loadContainer, showContainerError } from "./containerSettings";
import { toErrorState } from "./errors";
import { locale, setLocale } from "./i18n";
import { loadModelSettings } from "./modelSettings";


/** 表示中の画面。設定は全画面で開く。 */
export type View = "chat" | "settings";

/** 設定画面のカテゴリ。導線から特定のカテゴリを直接開くために signal で持つ。 */
export type SettingsCategory = "general" | "model" | "container" | "advanced";

export const view = signal<View>("chat");
export const settingsCategory = signal<SettingsCategory>("general");
export const sessions = signal<readonly Session[]>([]);
export const activeSessionId = signal<string | null>(null);
export const messages = signal<readonly ChatMessage[]>([]);
/**
 * 生成中の本文。完了すると messages へ移り、ここは空に戻る。
 * ツールの呼び出しと結果は画面に出さないので、ここには持たない（引き受けの判定にだけ使う）。
 */
export const streamingText = signal("");
export const isStreaming = signal(false);
export const isLoadingMessages = signal(false);
export const errorCode = signal<api.ClientErrorCode | null>(null);
export const errorDetail = signal<string | null>(null);

/** 一覧にまだ載っていない新規セッションでは null になる（その場合は「新しいチャット」と表示する）。 */
export const activeSession = computed(
  () => sessions.value.find((session) => session.id === activeSessionId.value) ?? null,
);

/** 削除の確認ダイアログが対象にしている会話の id。null ならダイアログは閉じている。 */
const pendingDeleteSessionId = signal<string | null>(null);

/**
 * 右ペイン（コンテナの画面）を開いているかどうか。既定は閉じている。
 * 閉じている間は noVNC の接続も張らない（見ていない画面のために繋ぎっぱなしにしない）。
 */
export const computerPaneOpen = signal(false);

/**
 * 画面を操作できるかどうか。
 * ふだんは見るだけで、エージェントから引き受けている間だけ操作できる。
 */
export const computerViewOnly = signal(true);

/**
 * いまユーザーへ画面を渡しているかどうか。
 * エージェントが computer_ask_user を呼んだ時点で立ち、結果が届くと下りる。
 */
export const handoverActive = signal(false);

/**
 * ユーザーへ見せる頼み。渡していないときは null。
 * 何を頼むかはモデルが書くので空のこともあるため、待ちの有無は handoverActive で見る。
 */
export const handoverQuestion = signal<string | null>(null);

/**
 * 引き受けの返事を届ける。送った文は、そのまま computer_ask_user の戻り値になる。
 * これが済むと、ターンの中でツールの結果が流れてくる（画面も見るだけに戻る）。
 */
export async function answerHandover(
  answer: { kind: "done" } | { kind: "text"; text: string },
): Promise<void> {
  const sessionId = activeSessionId.value;
  if (sessionId === null || !handoverActive.value) return;

  clearError();
  try {
    await api.answerHandover(sessionId, answer);
  } catch (error) {
    reportError(error);
  }
}

/** 右ペインを開く。引き受けが始まったときにも使う。 */
export function openComputerPane(): void {
  computerPaneOpen.value = true;
}

/** 右ペインを閉じる。 */
export function closeComputerPane(): void {
  computerPaneOpen.value = false;
}

/** チャットの右上のボタン。 */
export function toggleComputerPane(): void {
  computerPaneOpen.value = !computerPaneOpen.value;
}

/** 確認ダイアログに出す会話。一覧から消えた id なら null になり、ダイアログも閉じる。 */
export const pendingDeleteSession = computed(
  () => sessions.value.find((session) => session.id === pendingDeleteSessionId.value) ?? null,
);

let controller: AbortController | null = null;

export async function bootstrap(): Promise<void> {
  setLocale(locale.value);

  // コンテナの状態は、チャット画面の案内（podman が無い場合）に使う。
  // 読めなくてもチャットは使えるので、待たずに進め、失敗は設定画面のエラーに残す。
  void loadContainer().catch(showContainerError);

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
  } catch (error) {
    // 履歴を読めない会話を開いたとき、前の会話を残したままにすると
    // 見出しと本文が食い違う。空にして、理由を画面に出す。
    messages.value = [];
    reportError(error);
  } finally {
    isLoadingMessages.value = false;
  }
}

export async function sendMessage(rawContent: string): Promise<void> {
  const content = rawContent.trim();
  if (content.length === 0) return;

  // 引き受けている間の入力は、新しい発言ではなくツールの戻り値になる。
  // 新しい発言として扱うと、ターンが 2 つ重なって会話の並びが崩れる。
  if (handoverActive.value) {
    await answerHandover({ kind: "text", text: content });
    return;
  }

  if (isStreaming.value) return;

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
    case "tool-call":
      // ツールの呼び出しは画面に出さない。画面を渡す頼みが来たときだけ、その場で操作できる状態にする。
      if (isAskUser(event.part)) beginHandover(questionOf(event.part.args));
      break;
    case "tool-result":
      // こちらも画面には出さない。引き受けの結果が届いたら、見るだけに戻す。
      if (isAskUser(event.part) && event.part.failed === false) endHandover();
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

/** 画面を渡す呼び出しかどうか。 */
function isAskUser(part: { server: string; tool: string }): boolean {
  return part.server === "computer" && part.tool === "ask_user";
}

/** 呼び出しの引数から、ユーザーへ見せる頼みを取り出す。 */
function questionOf(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;

  const question = (args as { question?: unknown }).question;
  return typeof question === "string" && question.trim().length > 0 ? question : null;
}

/** 引き受けを始める。ペインを開き、操作できるようにする。 */
function beginHandover(question: string | null): void {
  handoverActive.value = true;
  handoverQuestion.value = question;
  computerViewOnly.value = false;
  openComputerPane();
}

/** 引き受けを終える。見るだけに戻す。 */
function endHandover(): void {
  handoverActive.value = false;
  handoverQuestion.value = null;
  computerViewOnly.value = true;
}

function reportError(error: unknown): void {
  const state = toErrorState(error);
  errorCode.value = state.code;
  errorDetail.value = state.detail;
}

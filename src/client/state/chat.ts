import { signal } from "@preact/signals";
import type { ChatEvent, ChatMessage } from "../../shared/types";
import { locale } from "../i18n";
import * as api from "../lib/api";
import { ApiError } from "../lib/http";
import { interpretEvent } from "./chat-events";
import { clearChatError, showChatError } from "./failure";
import { answerHandover, beginHandover, endHandover, handoverActive } from "./handover";
import { activeTeraId } from "./session";

/**
 * チャットの状態と、1 ターンの送信。
 *
 * 確定した会話は messages、生成中の本文は streamingText に置く。
 * ツールの呼び出しと結果は画面に出さないので持たない（引き受けの判定にだけ使う）。
 */

export const messages = signal<readonly ChatMessage[]>([]);

/**
 * 生成中の本文。完了すると messages へ移り、ここは空に戻る。
 */
export const streamingText = signal("");
export const isStreaming = signal(false);
export const isLoadingMessages = signal(false);

/** 送信中のターン。停止はここから打ち切る。 */
let controller: AbortController | null = null;

export async function openTera(id: string): Promise<void> {
  stopStreaming();
  clearChatError();
  activeTeraId.value = id;
  isLoadingMessages.value = true;
  try {
    messages.value = await api.listMessages(id);
  } catch (error) {
    // 履歴を読めない Tera を開いたとき、前の履歴を残したままにすると
    // 見出しと本文が食い違う。空にして、理由を画面に出す。
    messages.value = [];
    showChatError(error);
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

  // 送り先は起動時に読んだ一覧から決まる。読めていないときは送り先が無い。
  const teraId = activeTeraId.value;
  if (teraId === null) {
    showChatError(new ApiError("tera_not_found"));
    return;
  }

  clearChatError();

  const abort = new AbortController();
  controller = abort;
  isStreaming.value = true;
  streamingText.value = "";

  try {
    for await (const event of api.streamTurn(teraId, content, locale.value, abort.signal)) {
      applyEvent(event);
    }
  } catch (error) {
    showChatError(error);
  } finally {
    isStreaming.value = false;
    streamingText.value = "";
    controller = null;
  }
}

export function stopStreaming(): void {
  controller?.abort();
  controller = null;
}

/** イベントを状態へ反映する。解釈は chat-events.ts が持つ。 */
function applyEvent(event: ChatEvent): void {
  const effect = interpretEvent(event);
  if (effect === null) return;

  switch (effect.kind) {
    case "message":
      messages.value = [...messages.value, effect.message];
      if (effect.message.role === "assistant") streamingText.value = "";
      break;
    case "assistant-start":
      streamingText.value = "";
      break;
    case "text":
      streamingText.value += effect.delta;
      break;
    case "handover-start":
      beginHandover(effect.question);
      break;
    case "handover-end":
      endHandover();
      break;
    case "error":
      showChatError(new ApiError(effect.code, effect.detail));
      break;
  }
}

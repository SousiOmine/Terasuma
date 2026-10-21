import { signal } from "@preact/signals";
import type { AttachmentPart, ChatEvent, ChatMessage, NoticePart, TextPart } from "../../shared/types";
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
 * 確定した会話は messages、いま届いているターンは liveTurn に置く。
 * ツールの呼び出しと結果は画面に出さないので持たない（引き受けの判定にだけ使う）。
 * 画面に出るのは、モデルの本文・添付・注記だけ。
 */

export const messages = signal<readonly ChatMessage[]>([]);

/** いま届いているターンの、画面に出す本文・添付・注記。 */
export type LiveTurn = {
  id: string;
  createdAt: number;
  parts: readonly (TextPart | AttachmentPart | NoticePart)[];
};

export const liveTurn = signal<LiveTurn | null>(null);
export const isStreaming = signal(false);
/** 停止を頼んで、ターンが止まるのを待っている。 */
export const isStopping = signal(false);
export const isLoadingMessages = signal(false);

/** いま繋いでいるターン。切り替えや停止で、古いターンの後始末が新しい状態を壊さないようにする。 */
type CurrentTurn = { teraId: string; controller: AbortController };
let current: CurrentTurn | null = null;

export async function openTera(id: string): Promise<void> {
  // 表示中のターンは捨てて、新しい Tera の履歴を読む。
  // サーバ側のターンは、接続が切れた時点でそれまでの内容を保存して終わる。
  current?.controller.abort();
  current = null;
  liveTurn.value = null;
  isStreaming.value = false;
  isStopping.value = false;
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

export async function sendMessage(rawContent: string, files: readonly File[]): Promise<void> {
  const content = rawContent.trim();
  if (content.length === 0 && files.length === 0) return;

  // 引き受けている間の入力は、新しい発言ではなくツールの戻り値になる。
  // 新しい発言として扱うと、ターンが 2 つ重なって会話の並びが崩れる。
  if (handoverActive.value) {
    if (content.length === 0) return;
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

  const controller = new AbortController();
  const turn: CurrentTurn = { teraId, controller };
  current = turn;
  isStreaming.value = true;
  isStopping.value = false;
  liveTurn.value = null;

  try {
    for await (const event of api.streamTurn(teraId, content, locale.value, files, controller.signal)) {
      applyEvent(event);
    }
  } catch (error) {
    showChatError(error);
  } finally {
    // タブを切り替えたあとに古いターンが終わっても、いまの画面は壊さない。
    if (current === turn) {
      settleLiveTurn(teraId);
      current = null;
      isStreaming.value = false;
      isStopping.value = false;
    }
  }
}

/**
 * assistant-done を受け取れなかったターンを、画面に残す。
 *
 * サーバはそれまでの本文や添付を必ず保存しているので、読み直せば同じ内容が履歴から出る。
 * ここでは読み直すまでの間、同じ id のローカルのメッセージとして置いておく。
 * 保存された連番は読み直したときに付く（画面は配列の順に並べるので、ここでは使わない）。
 */
function settleLiveTurn(teraId: string): void {
  const live = liveTurn.value;
  liveTurn.value = null;
  if (live === null || live.parts.length === 0) return;
  if (activeTeraId.value !== teraId) return;

  messages.value = [
    ...messages.value,
    {
      id: live.id,
      teraId,
      seq: 0,
      role: "assistant",
      content: "",
      attachments: null,
      parts: [...live.parts],
      createdAt: live.createdAt,
      usage: null,
    },
  ];
}

/**
 * 走っているターンを止める。SSE は閉じず、サーバがそれまでの内容を保存して
 * assistant-done を返すので、画面はそのまま確定した履歴へ移れる。
 */
export async function stopStreaming(): Promise<void> {
  const teraId = activeTeraId.value;
  if (teraId === null || !isStreaming.value || isStopping.value) return;

  isStopping.value = true;
  try {
    await api.stopTurn(teraId);
  } catch (error) {
    // 止められなかったので、ターンはそのまま続く。理由を出して、また押せるようにする。
    showChatError(error);
    isStopping.value = false;
  }
}

/** イベントを状態へ反映する。解釈は chat-events.ts が持つ。 */
function applyEvent(event: ChatEvent): void {
  const effect = interpretEvent(event);
  if (effect === null) return;

  switch (effect.kind) {
    case "message":
      if (effect.message.role === "assistant") liveTurn.value = null;
      messages.value = [...messages.value, effect.message];
      break;
    case "assistant-start":
      liveTurn.value = { id: effect.id, createdAt: effect.createdAt, parts: [] };
      break;
    case "assistant-part": {
      const live = liveTurn.value;
      if (live === null) throw new Error(`ターンの開始前にメッセージが届きました（${effect.id}）`);
      liveTurn.value = { ...live, parts: [...live.parts, effect.part] };
      break;
    }
    case "handover-start":
      beginHandover(effect.callId, effect.question);
      break;
    case "handover-end":
      endHandover(effect.callId);
      break;
    case "error":
      showChatError(new ApiError(effect.code, effect.detail));
      break;
  }
}

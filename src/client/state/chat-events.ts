import { ASK_USER_TOOL_NAME, TOOL_CALL_TOOL, TOOL_SERVER_ID } from "../../shared/tools";
import type { AttachmentPart, ChatEvent, ChatMessage, NoticePart, TextPart } from "../../shared/types";
import type { ClientErrorCode } from "../lib/http";

/**
 * 1 つのイベントが、画面の状態に何をするか。
 *
 * signal を直接触らず「何が起きたか」だけを返すので、DOM もブラウザも無しで確かめられる。
 * 状態の更新は chat.ts が行う。
 */

export type ChatEventEffect =
  | { kind: "message"; message: ChatMessage }
  | { kind: "assistant-start"; id: string; createdAt: number }
  | { kind: "assistant-part"; id: string; part: TextPart | AttachmentPart | NoticePart }
  | { kind: "handover-start"; callId: string; question: string | null }
  | { kind: "handover-end"; callId: string }
  | { kind: "error"; code: ClientErrorCode; detail: string | null };

/** イベントを、画面に必要な効果へ読み替える。表示に関係しないものは null。 */
export function interpretEvent(event: ChatEvent): ChatEventEffect | null {
  switch (event.type) {
    case "user-message":
    case "assistant-done":
      return { kind: "message", message: event.message };
    case "assistant-start":
      return { kind: "assistant-start", id: event.id, createdAt: event.createdAt };
    case "assistant-message":
    case "notice":
      // 本文・添付・注記。届いた単位のまま、その場で画面へ足す。
      return { kind: "assistant-part", id: event.id, part: event.part };
    case "tool-call":
      // ツールの呼び出しは画面に出さない。画面を渡す頼みが来たときだけ、その場で操作できる状態にする。
      return isAskUserCall(event.part)
        ? { kind: "handover-start", callId: event.part.id, question: questionOf(event.part.args) }
        : null;
    case "tool-result":
      // こちらも画面には出さない。どの呼び出しの結果かは id で分かるので、引き受けている
      // 呼び出し自身の結果なら、見るだけに戻す（失敗した呼び出しでは待ちが続いている）。
      return event.part.failed ? null : { kind: "handover-end", callId: event.part.id };
    case "error":
      return { kind: "error", code: event.code, detail: event.detail };
  }
}

/**
 * 画面を渡す呼び出しかどうか。
 * computer_ask_user は事前ロードされていないので、tool_call 越しに呼ばれる。
 */
function isAskUserCall(part: { server: string; tool: string; args: unknown }): boolean {
  if (part.server !== TOOL_SERVER_ID || part.tool !== TOOL_CALL_TOOL) return false;
  return recordOf(part.args)?.["name"] === ASK_USER_TOOL_NAME;
}

/** 呼び出しの引数から、ユーザーへ見せる頼みを取り出す。 */
function questionOf(args: unknown): string | null {
  const toolArgs = recordOf(recordOf(args)?.["args"]);
  const question = toolArgs?.["question"];
  return typeof question === "string" && question.trim().length > 0 ? question : null;
}

/** オブジェクトとして読める値だけを取り出す。 */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

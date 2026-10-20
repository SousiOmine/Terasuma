import { ASK_USER_TOOL, COMPUTER_SERVER_ID } from "../../shared/tools";
import type { ChatEvent, ChatMessage } from "../../shared/types";
import type { ClientErrorCode } from "../lib/http";

/**
 * 1 つのイベントが、画面の状態に何をするか。
 *
 * signal を直接触らず「何が起きたか」だけを返すので、DOM もブラウザも無しで確かめられる。
 * 状態の更新は chat.ts が行う。
 */

export type ChatEventEffect =
  | { kind: "message"; message: ChatMessage }
  | { kind: "assistant-start" }
  | { kind: "text"; delta: string }
  | { kind: "handover-start"; question: string | null }
  | { kind: "handover-end" }
  | { kind: "error"; code: ClientErrorCode; detail: string | null };

/** イベントを、画面に必要な効果へ読み替える。表示に関係しないものは null。 */
export function interpretEvent(event: ChatEvent): ChatEventEffect | null {
  switch (event.type) {
    case "user-message":
    case "assistant-done":
      return { kind: "message", message: event.message };
    case "assistant-start":
      return { kind: "assistant-start" };
    case "text-delta":
      return { kind: "text", delta: event.delta };
    case "tool-call":
      // ツールの呼び出しは画面に出さない。画面を渡す頼みが来たときだけ、その場で操作できる状態にする。
      return isAskUser(event.part) ? { kind: "handover-start", question: questionOf(event.part.args) } : null;
    case "tool-result":
      // こちらも画面には出さない。引き受けの結果が届いたら、見るだけに戻す。
      return isAskUser(event.part) && event.part.failed === false ? { kind: "handover-end" } : null;
    case "error":
      return { kind: "error", code: event.code, detail: event.detail };
  }
}

/** 画面を渡す呼び出しかどうか。 */
function isAskUser(part: { server: string; tool: string }): boolean {
  return part.server === COMPUTER_SERVER_ID && part.tool === ASK_USER_TOOL;
}

/** 呼び出しの引数から、ユーザーへ見せる頼みを取り出す。 */
function questionOf(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;

  const question = (args as { question?: unknown }).question;
  return typeof question === "string" && question.trim().length > 0 ? question : null;
}

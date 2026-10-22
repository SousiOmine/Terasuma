import { ASK_USER_TOOL_NAME, SET_ENV_TOOL_NAME, TOOL_CALL_TOOL, TOOL_SERVER_ID } from "../../shared/tools";
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
  | { kind: "env-request-start"; callId: string; name: string; description: string | null }
  /**
   * ユーザーの入力を待っていた呼び出しの結果が届いた。
   * どちらの待ち（画面の引き受け・環境変数）を終えるかは、id で判定する。
   */
  | { kind: "wait-end"; callId: string; failed: boolean }
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
    case "tool-call": {
      // ツールの呼び出しは画面に出さない。ユーザーの入力を待つ呼び出しだけ、その場で入力を出す。
      const ask = toolCallArgs(event.part, ASK_USER_TOOL_NAME);
      if (ask !== null) {
        const question = ask["question"];
        return {
          kind: "handover-start",
          callId: event.part.id,
          question: typeof question === "string" && question.trim().length > 0 ? question : null,
        };
      }

      const env = toolCallArgs(event.part, SET_ENV_TOOL_NAME);
      const name = env?.["name"];
      // 名前が無いと何を設定するのか画面に出せないので、その場合は何もしない。
      if (env === null || typeof name !== "string" || name.length === 0) return null;

      const description = env["description"];
      return {
        kind: "env-request-start",
        callId: event.part.id,
        name,
        description: typeof description === "string" && description.trim().length > 0 ? description : null,
      };
    }
    case "tool-result":
      // こちらも画面には出さない。どの呼び出しの結果かは id で分かるので、待ちを終える材料にする。
      return { kind: "wait-end", callId: event.part.id, failed: event.part.failed };
    case "error":
      return { kind: "error", code: event.code, detail: event.detail };
  }
}

/**
 * tool_call 越しに呼ばれた、指定したツールの引数。そのツールの呼び出しでなければ null。
 * computer_ask_user と computer_set_env は事前ロードされていないので、tool_call 越しに呼ばれる。
 */
function toolCallArgs(
  part: { server: string; tool: string; args: unknown },
  name: string,
): Record<string, unknown> | null {
  if (part.server !== TOOL_SERVER_ID || part.tool !== TOOL_CALL_TOOL) return null;

  const outer = recordOf(part.args);
  if (outer?.["name"] !== name) return null;
  return recordOf(outer["args"]) ?? {};
}

/** オブジェクトとして読める値だけを取り出す。 */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

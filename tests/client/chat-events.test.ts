import { describe, expect, test } from "bun:test";
import { interpretEvent } from "../../src/client/state/chat-events";
import type { AttachmentPart, ChatMessage, NoticePart, TextPart } from "../../src/shared/types";

/**
 * SSE のイベントを、画面の状態に何をするかへ読み替える部分。
 * signal も DOM も使わないので、そのまま確かめられる。
 */

const message: ChatMessage = {
  id: "m1",
  teraId: "t1",
  seq: 2,
  role: "assistant",
  content: "",
  attachments: null,
  parts: [{ type: "text", text: "こんにちは", at: 1 }],
  createdAt: 1,
  usage: null,
};

const text: TextPart = { type: "text", text: "こんにちは", at: 2 };
const attachment: AttachmentPart = {
  type: "attachment",
  attachments: [{ name: "図.png", size: 12, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
  at: 3,
};
const notice: NoticePart = { type: "notice", text: "上限に達しました", at: 4 };

describe("チャットのイベントの読み替え", () => {
  test("メッセージはそのまま足す", () => {
    expect(interpretEvent({ type: "user-message", message })).toEqual({ kind: "message", message });
    expect(interpretEvent({ type: "assistant-done", message })).toEqual({ kind: "message", message });
  });

  test("ターンの開始は、届いているターンの入れ替えになる", () => {
    expect(interpretEvent({ type: "assistant-start", id: "a1", createdAt: 1 })).toEqual({
      kind: "assistant-start",
      id: "a1",
      createdAt: 1,
    });
  });

  test("本文・添付・注記は、届いた単位で足す", () => {
    expect(interpretEvent({ type: "assistant-message", id: "a1", part: text })).toEqual({
      kind: "assistant-part",
      id: "a1",
      part: text,
    });
    expect(interpretEvent({ type: "assistant-message", id: "a1", part: attachment })).toEqual({
      kind: "assistant-part",
      id: "a1",
      part: attachment,
    });
    expect(interpretEvent({ type: "notice", id: "a1", part: notice })).toEqual({
      kind: "assistant-part",
      id: "a1",
      part: notice,
    });
  });

  test("tool_call 越しの画面を渡す呼び出しだけ、引き受けの開始になる", () => {
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c1",
          server: "tool",
          tool: "call",
          args: { name: "computer_ask_user", args: { question: "ログイン" } },
        },
      }),
    ).toEqual({ kind: "handover-start", callId: "c1", question: "ログイン" });

    // 頼みが空でも、引き受けは始まる（何を頼むかを書いていないだけ）。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c2", server: "tool", tool: "call", args: { name: "computer_ask_user" } },
      }),
    ).toEqual({ kind: "handover-start", callId: "c2", question: null });

    // tool_call 越しでも、ほかのツールは画面に出さない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c3", server: "tool", tool: "call", args: { name: "computer_screenshot" } },
      }),
    ).toBeNull();

    // ツール検索も画面には出さない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c4", server: "tool", tool: "search", args: { query: "computer" } },
      }),
    ).toBeNull();
  });

  test("引き受けの結果で、操作できる状態が終わる", () => {
    const part = {
      type: "tool-result" as const,
      id: "c1",
      server: "tool",
      tool: "call",
      failed: false,
      output: "[computer_ask_user]\ndone",
    };

    expect(interpretEvent({ type: "tool-result", id: "a1", part })).toEqual({ kind: "handover-end", callId: "c1" });

    // 失敗した呼び出しでは、まだユーザーの操作待ちが続いている。
    expect(interpretEvent({ type: "tool-result", id: "a1", part: { ...part, failed: true } })).toBeNull();
  });

  test("失敗はコードと詳細を運ぶ", () => {
    expect(interpretEvent({ type: "error", code: "model_error", detail: "失敗" })).toEqual({
      kind: "error",
      code: "model_error",
      detail: "失敗",
    });
  });
});

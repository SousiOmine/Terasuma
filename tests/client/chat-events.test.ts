import { describe, expect, test } from "bun:test";
import { interpretEvent } from "../../src/client/state/chat-events";
import type { ChatMessage } from "../../src/shared/types";

/**
 * SSE のイベントを、画面の状態に何をするかへ読み替える部分。
 * signal も DOM も使わないので、そのまま確かめられる。
 */

const message: ChatMessage = {
  id: "m1",
  teraId: "t1",
  seq: 1,
  role: "assistant",
  content: "こんにちは",
  attachments: null,
  parts: null,
  createdAt: 1,
  usage: null,
};

describe("チャットのイベントの読み替え", () => {
  test("本文の差分は追記になる", () => {
    expect(interpretEvent({ type: "text-delta", id: "a1", delta: "こん" })).toEqual({
      kind: "text",
      delta: "こん",
    });
  });

  test("メッセージはそのまま足す", () => {
    expect(interpretEvent({ type: "user-message", message })).toEqual({ kind: "message", message });
    expect(interpretEvent({ type: "assistant-done", message })).toEqual({ kind: "message", message });
  });

  test("生成の開始は本文の入れ替えになる", () => {
    expect(interpretEvent({ type: "assistant-start", id: "a1", createdAt: 1 })).toEqual({
      kind: "assistant-start",
    });
  });

  test("画面を渡す呼び出しだけ、引き受けの開始になる", () => {
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c1", server: "computer", tool: "ask_user", args: { question: "ログイン" } },
      }),
    ).toEqual({ kind: "handover-start", question: "ログイン" });

    // ほかのツールは画面に出さない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c2", server: "computer", tool: "screenshot", args: {} },
      }),
    ).toBeNull();
  });

  test("引き受けの結果で、操作できる状態が終わる", () => {
    const part = {
      type: "tool-result" as const,
      id: "c1",
      server: "computer",
      tool: "ask_user",
      failed: false,
      output: "done",
    };

    expect(interpretEvent({ type: "tool-result", id: "a1", part })).toEqual({ kind: "handover-end" });

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

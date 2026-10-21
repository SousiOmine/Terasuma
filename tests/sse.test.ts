import { describe, expect, test } from "bun:test";
import { decodeChatEvents, encodeChatEvent } from "../src/shared/sse";
import type { ChatEvent, SentPart } from "../src/shared/types";

const part: SentPart = { type: "sent", text: "こんにちは", attachments: [], at: 2 };

const events: ChatEvent[] = [
  { type: "assistant-start", id: "a1", createdAt: 1 },
  { type: "assistant-message", id: "a1", part },
  { type: "notice", id: "a1", part: { type: "notice", text: "止まりました", at: 3 } },
  { type: "error", code: "model_error", detail: "失敗した" },
];

describe("SSE", () => {
  test("エンコードしたものをまとめてデコードできる", () => {
    const wire = events.map(encodeChatEvent).join("");

    const decoded = decodeChatEvents(wire);
    expect(decoded.events).toEqual(events);
    expect(decoded.rest).toBe("");
  });

  test("フレームの途中で切れても、次のチャンクと連結すれば復元できる", () => {
    const wire = events.map(encodeChatEvent).join("");
    const boundary = wire.indexOf("\n\n") - 5; // 1 フレーム目の本文の途中で切る

    const first = decodeChatEvents(wire.slice(0, boundary));
    expect(first.events).toHaveLength(0);
    expect(first.rest).toBe(wire.slice(0, boundary));

    const second = decodeChatEvents(first.rest + wire.slice(boundary));
    expect(second.events).toEqual(events);
    expect(second.rest).toBe("");
  });

  test("フレーム単位で切り出し、未完の分は rest に残す", () => {
    const wire = events.map(encodeChatEvent).join("");
    const afterFirst = wire.indexOf("\n\n") + 2; // 1 フレーム目までちょうど

    const decoded = decodeChatEvents(wire.slice(0, afterFirst));
    expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toEqual(events[0]);
    expect(decoded.rest).toBe("");
  });

  test("改行を含む本文もそのまま往復する", () => {
    const event: ChatEvent = {
      type: "assistant-done",
      message: {
        id: "a1",
        teraId: "t1",
        seq: 2,
        role: "assistant",
        content: "",
        attachments: null,
        parts: [
          {
            type: "sent",
            text: "1行目\n2行目\n```ts\nconst a = 1;\n```",
            attachments: [{ name: "図.png", size: 12, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
            at: 1,
          },
        ],
        createdAt: 1,
        usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 },
      },
    };

    expect(decodeChatEvents(encodeChatEvent(event)).events).toEqual([event]);
  });

  test("data 行が無いフレームは無視する", () => {
    const decoded = decodeChatEvents(": コメントだけ\n\n");
    expect(decoded.events).toEqual([]);
    expect(decoded.rest).toBe("");
  });

  test("JSON として読めないフレームは、そのまま捨てずに例外を投げる", () => {
    expect(() => decodeChatEvents("data: not-json\n\n")).toThrow();
  });
});

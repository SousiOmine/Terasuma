import { describe, expect, test } from "bun:test";
import {
  decodeChatEvents,
  decodeConversationEvents,
  encodeChatEvent,
  encodeConversationEvent,
} from "../src/shared/sse";
import type { ConversationEvent } from "../src/shared/api/events";
import type { ChatEvent, TextPart } from "../src/shared/api/message";
import { createSseResponse } from "../src/server/http/sse";

const part: TextPart = { type: "text", text: "こんにちは", at: 2 };

const events: ChatEvent[] = [
  { type: "assistant-start", id: "a1", createdAt: 1, seq: 1 },
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
        origin: null,
        parts: [
          {
            type: "text",
            text: "1行目\n2行目\n```ts\nconst a = 1;\n```",
            at: 1,
          },
          {
            type: "attachment",
            attachments: [{ name: "図.png", size: 12, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
            at: 2,
          },
        ],
        createdAt: 1,
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

  test("会話の購読のイベント（sync・turn-ended）も往復する", () => {
    const conversation: ConversationEvent[] = [
      { type: "sync", lastSeq: 3, turnRunning: true },
      { type: "turn-ended" },
      ...events,
    ];
    const wire = conversation.map(encodeConversationEvent).join("");

    expect(decodeConversationEvents(wire).events).toEqual(conversation);
  });

  test("購読のイベントとして読めない形は、例外にする", () => {
    expect(() => decodeConversationEvents('data: {"type":"sync","lastSeq":"x"}\n\n')).toThrow();
  });

  test("continueOnCancel なら、読み手が離れてもイベント列を最後まで読む", async () => {
    let nextCalls = 0;
    const source = (async function* () {
      for (let index = 0; index < 3; index += 1) {
        nextCalls += 1;
        yield index;
      }
    })();

    const response = createSseResponse(source, (event) => `data: ${event}\n\n`, { continueOnCancel: true });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("本文が無い");

    await reader.read();
    await reader.cancel();

    const deadline = Date.now() + 1_000;
    while (nextCalls < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(nextCalls).toBe(3);
  });

  test("既定では、読み手が離れるとイベント列を閉じ、残りを読まない", async () => {
    let nextCalls = 0;
    let returned = false;
    const source = (async function* () {
      try {
        for (let index = 0; index < 3; index += 1) {
          nextCalls += 1;
          yield index;
        }
      } finally {
        returned = true;
      }
    })();

    const response = createSseResponse(source, (event) => `data: ${event}\n\n`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("本文が無い");

    await reader.read();
    await reader.cancel();

    expect(returned).toBe(true);
    expect(nextCalls).toBeLessThan(3);
  });
});

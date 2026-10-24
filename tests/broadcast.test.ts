import { describe, expect, test } from "bun:test";
import { createConversationBroadcast } from "../src/server/agent/broadcast";
import type { ConversationEvent } from "../src/shared/api/events";
import type { ChatEvent, ChatMessageView } from "../src/shared/api/message";

/**
 * 配り口（broadcast）だけを、HTTP を通さずに確かめる。
 * 誰に配るか・途中から購読した画面に何を流すか・読み手が止まったらどうするかを、ここで固定する。
 */

/** 保存済みの発言 1 件。 */
function message(id: string): ChatMessageView {
  return { id, teraId: "t1", seq: 1, role: "user", content: id, attachments: null, parts: null, createdAt: 1 };
}

const started: ChatEvent = { type: "assistant-start", id: "a1", createdAt: 2, seq: 2 };
const part: ChatEvent = { type: "assistant-message", id: "a1", part: { type: "text", text: "こんにちは", at: 3 } };
const done: ChatEvent = {
  type: "assistant-done",
  message: {
    id: "a1",
    teraId: "t1",
    seq: 2,
    role: "assistant",
    content: "",
    attachments: null,
    parts: [{ type: "text", text: "こんにちは", at: 3 }],
    createdAt: 2,
  },
};

/** 購読を開き、後始末のために signal も一緒に返す。 */
function subscribe(
  broadcast: ReturnType<typeof createConversationBroadcast>,
  clientId: string,
): { next(): Promise<IteratorResult<ConversationEvent>>; abort(): void } {
  const controller = new AbortController();
  const iterator = broadcast.subscribe("t1", clientId, controller.signal)[Symbol.asyncIterator]();

  return {
    next: () => iterator.next(),
    abort: () => controller.abort(),
  };
}

describe("会話の配り口", () => {
  test("送った画面の購読を飛ばし、ほかの購読へはそのまま配る", async () => {
    const broadcast = createConversationBroadcast();
    const sender = subscribe(broadcast, "sender");
    const watcher = subscribe(broadcast, "watcher");

    broadcast.publish("t1", { type: "user-message", message: message("m1") }, "sender");

    expect(await watcher.next()).toEqual({ done: false, value: { type: "user-message", message: message("m1") } });

    // 送った画面には溜まっていない。購読を畳むと、待たずに終わりが返る。
    sender.abort();
    expect(await sender.next()).toEqual({ done: true, value: undefined });
  });

  test("走っているターンの途中から購読しても、始まったところから流れる", async () => {
    const broadcast = createConversationBroadcast();
    const early = subscribe(broadcast, "early");

    broadcast.publish("t1", started, "early");
    broadcast.publish("t1", part, "early");

    // ターンの途中で開いた購読は、まず始まりから受け取る。
    const late = subscribe(broadcast, "late");
    expect(await late.next()).toEqual({ done: false, value: started });
    expect(await late.next()).toEqual({ done: false, value: part });

    // そのあとに起きたことも、続けて届く。
    broadcast.publish("t1", done, "early");
    expect(await late.next()).toEqual({ done: false, value: done });

    for (const subscriber of [early, late]) subscriber.abort();
  });

  test("ステップが変わっても、途中から購読した画面へ両方の assistant-start が流れる", async () => {
    const broadcast = createConversationBroadcast();
    const early = subscribe(broadcast, "early");

    broadcast.publish("t1", started, "early");
    broadcast.publish("t1", part, "early");

    // ステップ 2 の開始より前に購読を開く。控えには始まりから積まれている。
    const late = subscribe(broadcast, "late");

    const secondStarted: ChatEvent = { type: "assistant-start", id: "a2", createdAt: 4, seq: 4 };
    const secondPart: ChatEvent = {
      type: "assistant-message",
      id: "a2",
      part: { type: "text", text: "続き", at: 5 },
    };
    broadcast.publish("t1", secondStarted, "early");
    broadcast.publish("t1", secondPart, "early");

    expect(await late.next()).toEqual({ done: false, value: started });
    expect(await late.next()).toEqual({ done: false, value: part });
    expect(await late.next()).toEqual({ done: false, value: secondStarted });
    expect(await late.next()).toEqual({ done: false, value: secondPart });

    for (const subscriber of [early, late]) subscriber.abort();
  });

  test("終わったターンは、購読し直しても流し直さない（履歴を読み直せば揃う）", async () => {
    const broadcast = createConversationBroadcast();
    const early = subscribe(broadcast, "early");

    broadcast.publish("t1", started, "early");
    broadcast.publish("t1", done, "early");

    const late = subscribe(broadcast, "late");
    late.abort();
    expect(await late.next()).toEqual({ done: true, value: undefined });

    early.abort();
  });

  test("終わりを流せなかったターンは、終わったことだけを配る", async () => {
    const broadcast = createConversationBroadcast();
    const watcher = subscribe(broadcast, "watcher");

    // 送った画面は 2 つ目まで受け取ったところで離れる（最後まで流せない）。
    const sender = (async function* (): AsyncGenerator<ChatEvent> {
      yield { type: "user-message", message: message("m1") };
      yield started;
    })();
    const relay = broadcast.relay("t1", sender, "sender");

    expect(await relay.next()).toEqual({ done: false, value: { type: "user-message", message: message("m1") } });
    expect(await relay.next()).toEqual({ done: false, value: started });
    expect(await relay.next()).toEqual({ done: true, value: undefined });

    expect(await watcher.next()).toEqual({ done: false, value: { type: "user-message", message: message("m1") } });
    expect(await watcher.next()).toEqual({ done: false, value: started });
    expect(await watcher.next()).toEqual({ done: false, value: { type: "turn-ended" } });

    watcher.abort();
  });

  test("終わりまで流せたターンには、終わったことを足さない", async () => {
    const broadcast = createConversationBroadcast();
    const watcher = subscribe(broadcast, "watcher");

    const sender = (async function* (): AsyncGenerator<ChatEvent> {
      yield started;
      yield done;
    })();
    const relay = broadcast.relay("t1", sender, "sender");
    while (!(await relay.next()).done) {
      // 送った画面の応答を読み切る。
    }

    expect(await watcher.next()).toEqual({ done: false, value: started });
    expect(await watcher.next()).toEqual({ done: false, value: done });

    // 終わったあとに足されるものは無い。
    watcher.abort();
    expect(await watcher.next()).toEqual({ done: true, value: undefined });
  });

  test("読み手が追いつかない購読は、溜め続けずに切る", async () => {
    const broadcast = createConversationBroadcast();
    const stalled = subscribe(broadcast, "stalled");

    // 上限（1000）を超えるまで配り、読まないまま溜めさせる。
    for (let index = 0; index < 1_001; index += 1) {
      broadcast.publish(
        "t1",
        { type: "assistant-message", id: "a1", part: { type: "text", text: ".", at: index } },
        "sender",
      );
    }

    // 溜めた分は捨て、購読を終える（画面は繋ぎ直し、sync から取り直す）。
    expect(await stalled.next()).toEqual({ done: true, value: undefined });
  });
});

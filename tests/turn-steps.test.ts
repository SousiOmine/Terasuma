import { describe, expect, test } from "bun:test";
import { createStepMessages } from "../src/server/conversation/step-messages";
import { DEFAULT_TERA_ID, type Store } from "../src/server/data/store";
import { CHAT_SERVER_ID, UI_TOOL } from "../src/shared/tools";
import type { MessagePart } from "../src/shared/api/message";
import { makeStore } from "./support";

/** その Tera に保存されている行（古い順）。 */
function saved(store: Store) {
  return store.listMessagesSince(DEFAULT_TERA_ID, 0);
}

const text = (value: string): MessagePart => ({ type: "text", text: value, at: 1 });
const attachment: MessagePart = {
  type: "attachment",
  attachments: [{ name: "a.txt", size: 3, url: "/api/files/a", image: null }],
  at: 1,
};
const notice: MessagePart = { type: "notice", text: "上限に達しました", at: 1 };
const uiCall: MessagePart = {
  type: "tool-call",
  id: "call-ui",
  server: CHAT_SERVER_ID,
  tool: UI_TOOL,
  args: {},
};
const plainCall: MessagePart = {
  type: "tool-call",
  id: "call-echo",
  server: "local",
  tool: "echo",
  args: {},
};

describe("ステップごとの行", () => {
  test("current は行を予約し、nextStep で次の連番の行へ進む", () => {
    const store = makeStore();
    const steps = createStepMessages(store, DEFAULT_TERA_ID);

    const first = steps.current();
    expect(first.parts).toEqual([]);
    expect(saved(store).map((message) => [message.id, message.seq])).toEqual([[first.id, first.seq]]);

    first.parts.push(text("ステップ 1"));
    const second = steps.nextStep(null);
    expect(second.id).not.toBe(first.id);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(steps.current()).toBe(second);
  });

  test("nextStep は前の行を parts 付きで保存する", () => {
    const store = makeStore();
    const steps = createStepMessages(store, DEFAULT_TERA_ID);

    const first = steps.current();
    first.parts.push(text("ステップ 1"));
    const second = steps.nextStep(null);
    second.parts.push(text("ステップ 2"));

    const rows = saved(store);
    expect(rows.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(rows[0]?.parts).toEqual([text("ステップ 1")]);
    expect(rows[1]?.parts).toEqual([]);
  });

  test("何も出なかった行は、nextStep と finish で消える", () => {
    const store = makeStore();
    const steps = createStepMessages(store, DEFAULT_TERA_ID);

    const first = steps.current();
    // 最初の行は空のまま次のステップへ進む（消える）。
    const second = steps.nextStep(null);
    expect(saved(store).map((message) => message.id)).toEqual([second.id]);
    expect(saved(store).some((message) => message.id === first.id)).toBe(false);

    // 最後の行も空のままターンが終わる（消える）。
    expect(steps.finish(null)).toBeNull();
    expect(saved(store)).toEqual([]);
  });

  test("finish は最後の行を返し、parts と usage を書き込む", () => {
    const store = makeStore();
    const steps = createStepMessages(store, DEFAULT_TERA_ID);
    const usage = { inputTokens: 10, outputTokens: 20, cachedInputTokens: 5 };

    const current = steps.current();
    current.parts.push(text("最後の返事"));

    const finished = steps.finish(usage);
    if (finished === null) throw new Error("最後の行が返らなかった");
    expect(finished.id).toBe(current.id);
    expect(finished.seq).toBe(current.seq);
    expect(finished.parts).toEqual([text("最後の返事")]);
    expect(finished.usage).toEqual(usage);

    const rows = saved(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: current.id, seq: current.seq, parts: [text("最後の返事")], usage });
  });

  test("nextStep に渡した usage は、そのステップの行に残る", () => {
    const store = makeStore();
    const steps = createStepMessages(store, DEFAULT_TERA_ID);
    const usage = { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 };

    const first = steps.current();
    first.parts.push(text("途中"));
    steps.nextStep(usage);

    expect(saved(store)[0]).toMatchObject({ id: first.id, usage });
  });

  test("sawContent は、本文・添付・注記・chat_ui のどれかで true になる", () => {
    for (const part of [text("本文"), attachment, notice, uiCall]) {
      const store = makeStore();
      const steps = createStepMessages(store, DEFAULT_TERA_ID);
      steps.current().parts.push(part);
      steps.finish(null);

      expect(steps.sawContent(), `${part.type} を見落とした`).toBe(true);
    }
  });

  test("空白だけの本文と、画面に出ないツール呼び出しだけでは sawContent は false のまま", () => {
    const store = makeStore();
    const steps = createStepMessages(store, DEFAULT_TERA_ID);

    steps.current().parts.push(text("   "));
    steps.nextStep(null).parts.push(plainCall);
    steps.finish(null);

    expect(steps.sawContent()).toBe(false);
  });
});

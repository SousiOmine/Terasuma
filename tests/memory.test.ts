import { describe, expect, test } from "bun:test";
import type { CompleteInput } from "../src/server/engine";
import { createMemory, estimateMessageTokens, estimateTokens, type Memory } from "../src/server/memory";
import { DEFAULT_TERA_ID, type Store } from "../src/server/store";
import type { ChatMessage } from "../src/shared/types";
import { makeStore } from "./support";

/**
 * 観察と反映の閾値は 3 万 / 4 万トークンなので、閾値をまたぐ履歴を作って確かめる。
 * 本文はすべて半角にして、トークンの目安（半角 4 文字で 1 トークン）を狙って作る。
 * 先頭には何番目のメッセージかが分かる番号を置く（観察へ渡る本文は切り詰められるので、頭に置く）。
 */
function body(tokens: number, index: number): string {
  return index.toString().padStart(8, "0") + "a".repeat(Math.max(0, tokens * 4 - 8));
}

/** ストアに、同じ大きさのメッセージを並べる。 */
function seed(store: Store, tokensEach: number, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    store.appendMessage({
      id: `m${index}`,
      teraId: DEFAULT_TERA_ID,
      role: "user",
      content: body(tokensEach, index),
    });
  }
}

/** complete の呼び出しを記録し、決めた応答を返すエンジン。 */
function createMemoryEngine(reply: (input: CompleteInput) => string | Promise<string>) {
  const calls: CompleteInput[] = [];
  return {
    calls,
    engine: {
      complete(input: CompleteInput): Promise<string> {
        calls.push(input);
        return Promise.resolve(reply(input));
      },
    },
  };
}

/** 応答を待たせるための門。更新が走っている間の振る舞いを確かめるのに使う。 */
function createGate() {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => open() };
}

describe("記憶の更新", () => {
  test("閾値に届かなければ、観察も反映もしない", async () => {
    const store = makeStore();
    seed(store, 1_000, 20); // 2 万トークン

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    const memory = createMemory({ store, engine: fake.engine, log: () => undefined });

    await memory.update(DEFAULT_TERA_ID);

    expect(fake.calls).toHaveLength(0);
    expect(store.readObservations(DEFAULT_TERA_ID)).toEqual({ text: "", throughSeq: 0 });
    expect(memory.context(DEFAULT_TERA_ID).messages).toHaveLength(20);
  });

  test("閾値を超えたら、古い方から観察し、直近は生のまま残す", async () => {
    const store = makeStore();
    seed(store, 1_000, 40); // 4 万トークン

    const fake = createMemoryEngine(() => "Date: 2026-10-16\n* 🔴 (09:00) 観察した");
    const memory = createMemory({ store, engine: fake.engine, log: () => undefined });

    await memory.update(DEFAULT_TERA_ID);

    // 一度に観察するのは 3 万トークンまで。1 件 1,000 トークンなので 30 件。
    expect(fake.calls).toHaveLength(1);
    expect(store.readObservations(DEFAULT_TERA_ID)).toEqual({
      text: "Date: 2026-10-16\n* 🔴 (09:00) 観察した",
      throughSeq: 30,
    });

    // 観察へ渡した本文は 30 件目まで。31 件目からは渡っていない。
    const prompt = fake.calls[0]?.prompt ?? "";
    expect(prompt).toContain("00000001");
    expect(prompt).toContain("00000030");
    expect(prompt).not.toContain("00000031");

    // 直近（残り 10 件）は生のまま残る。
    const context = memory.context(DEFAULT_TERA_ID);
    expect(context.observations).toBe("Date: 2026-10-16\n* 🔴 (09:00) 観察した");
    expect(context.messages.map((message) => message.seq)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
  });

  test("1 回の更新で観察するのは 3 往復まで（続きは次の更新で進む）", async () => {
    const store = makeStore();
    seed(store, 1_000, 200); // 20 万トークン

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    const memory = createMemory({ store, engine: fake.engine, log: () => undefined });

    await memory.update(DEFAULT_TERA_ID);
    expect(fake.calls).toHaveLength(3);
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(90);

    await memory.update(DEFAULT_TERA_ID);
    expect(fake.calls).toHaveLength(6);
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(180);
  });

  test("記録が閾値を超えたら、書き直して縮める", async () => {
    const store = makeStore();
    // 反映の閾値（4 万トークン）を超える記録を置く。
    const log = `Date: 2026-10-16\n* 🔴 (09:00) ${"b".repeat(4 * 41_000)}`;
    store.writeObservations(DEFAULT_TERA_ID, { text: log, throughSeq: 7 });

    const fake = createMemoryEngine(() => "Date: 2026-10-16\n* 🔴 (09:00) 縮めた記録");
    const memory = createMemory({ store, engine: fake.engine, log: () => undefined });

    await memory.update(DEFAULT_TERA_ID);

    // 反映には、いまの記録そのものが渡る（観察の呼び出しではない）。
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt).toBe(log);

    // 書き直しても、どこまで観察したかは動かさない。
    expect(store.readObservations(DEFAULT_TERA_ID)).toEqual({
      text: "Date: 2026-10-16\n* 🔴 (09:00) 縮めた記録",
      throughSeq: 7,
    });
  });

  test("観察に失敗したら、記録は変えずに理由を出す", async () => {
    const store = makeStore();
    seed(store, 1_000, 40);

    const logs: string[] = [];
    const memory = createMemory({
      store,
      engine: { complete: () => Promise.reject(new Error("繋がらない")) },
      log: (message) => logs.push(message),
    });

    await memory.update(DEFAULT_TERA_ID);

    expect(store.readObservations(DEFAULT_TERA_ID)).toEqual({ text: "", throughSeq: 0 });
    expect(logs.join("\n")).toContain("繋がらない");
    // 観察していない分は生のまま渡るので、内容は失われない。
    expect(memory.context(DEFAULT_TERA_ID).messages).toHaveLength(40);
  });

  test("中身の無い応答は、記録にしない", async () => {
    for (const reply of ["", "   \n", "Date: 2026-10-16\n"]) {
      const store = makeStore();
      seed(store, 1_000, 40);

      const logs: string[] = [];
      const memory = createMemory({
        store,
        engine: { complete: () => Promise.resolve(reply) },
        log: (message) => logs.push(message),
      });

      await memory.update(DEFAULT_TERA_ID);

      // 中身が無いまま進めると、観察したはずのやり取りがどこにも残らなくなる。
      expect(store.readObservations(DEFAULT_TERA_ID)).toEqual({ text: "", throughSeq: 0 });
      expect(logs.join("\n")).toContain("観察");
    }
  });

  test("同じ Tera の更新は重ねて走らせない", async () => {
    const store = makeStore();
    seed(store, 1_000, 40);

    const gate = createGate();
    const fake = createMemoryEngine(async () => {
      await gate.gate;
      return "* 🔴 (09:00) 観察した";
    });
    const memory = createMemory({ store, engine: fake.engine, log: () => undefined });

    const first = memory.update(DEFAULT_TERA_ID);
    const second = memory.update(DEFAULT_TERA_ID);
    expect(second).toBe(first);

    gate.open();
    await first;

    expect(fake.calls).toHaveLength(1);
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(30);
  });

  test("settle は、走っている更新が終わるまで待つ", async () => {
    const store = makeStore();
    seed(store, 1_000, 40);

    const gate = createGate();
    const fake = createMemoryEngine(async () => {
      await gate.gate;
      return "* 🔴 (09:00) 観察した";
    });
    const memory = createMemory({ store, engine: fake.engine, log: () => undefined });

    const updating = memory.update(DEFAULT_TERA_ID);
    // 待っている間は、まだ記録が書かれていない。
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(0);

    gate.open();
    await memory.settle(DEFAULT_TERA_ID);

    // settle が返った時点で、更新は終わっている。
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(30);
    await updating;

    // 走っていなければ、待たずに返る。
    await memory.settle(DEFAULT_TERA_ID);
  });
});

describe("記録の育ち方", () => {
  test("記録は追記だけで育ち、同じ日付の見出しは繰り返さない", async () => {
    const store = makeStore();
    store.writeObservations(DEFAULT_TERA_ID, {
      text: "Date: 2026-10-16\n* 🔴 (09:00) 前からある記録",
      throughSeq: 0,
    });
    seed(store, 1_000, 80); // 2 往復する長さ

    const replies = ["Date: 2026-10-16\n* 🟡 (10:00) 足した記録", "Date: 2026-10-17\n* 🔴 (09:00) 別の日の記録"];
    let index = 0;
    const memory = createMemory({
      store,
      engine: { complete: () => Promise.resolve(replies[index++] ?? "") },
      log: () => undefined,
    });

    await memory.update(DEFAULT_TERA_ID);

    const text = store.readObservations(DEFAULT_TERA_ID).text;
    expect(text.startsWith("Date: 2026-10-16\n* 🔴 (09:00) 前からある記録")).toBe(true);
    expect(text).toContain("🟡 (10:00) 足した記録");
    expect(text).toContain("Date: 2026-10-17\n* 🔴 (09:00) 別の日の記録");
    // 同じ日付の見出しは増えない（日付ごとに 1 つの並びになる）。
    expect(text.match(/^Date: 2026-10-16$/gm)).toHaveLength(1);
  });
});

describe("トークンの目安", () => {
  test("半角は 4 文字で 1、それ以外は 1 文字で 1 として数える", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("あいうえお")).toBe(5);
    // 日本語 1 文字 + 半角 5 文字 → 1 + 2
    expect(estimateTokens("あbcdef")).toBe(3);
  });

  test("ツールの結果と画像も数える", () => {
    const message: ChatMessage = {
      id: "m1",
      teraId: DEFAULT_TERA_ID,
      seq: 1,
      role: "assistant",
      content: "abcd",
      parts: [
        { type: "text", text: "abcd" }, // 1
        { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: "abcd" }, // """abcd""" で 2
        {
          type: "tool-result",
          id: "call-1",
          server: "local",
          tool: "echo",
          failed: false,
          output: "abcdefgh", // 2
          image: { sha256: "0".repeat(64), mime: "image/png", width: 1280, height: 800 }, // 画像 1 枚分
        },
      ],
      createdAt: 0,
      usage: null,
    };

    expect(estimateMessageTokens(message)).toBe(1 + 2 + 2 + 1_000);

    // parts が無いメッセージは、本文だけを数える。
    expect(estimateMessageTokens({ ...message, parts: null })).toBe(1);
  });
});

describe("文脈の組み立て", () => {
  test("観察の記録と、まだ観察していない履歴が返る", () => {
    const store = makeStore();
    seed(store, 1_000, 5);
    store.writeObservations(DEFAULT_TERA_ID, { text: "* 🔴 (09:00) 観察した", throughSeq: 2 });

    const memory: Memory = createMemory({
      store,
      engine: { complete: () => Promise.resolve("") },
      log: () => undefined,
    });

    expect(memory.context(DEFAULT_TERA_ID)).toEqual({
      observations: "* 🔴 (09:00) 観察した",
      messages: store.listMessagesSince(DEFAULT_TERA_ID, 2),
    });
  });

  test("まだ観察していなければ、記録は null", () => {
    const store = makeStore();
    seed(store, 1_000, 1);

    const memory = createMemory({
      store,
      engine: { complete: () => Promise.resolve("") },
      log: () => undefined,
    });

    expect(memory.context(DEFAULT_TERA_ID).observations).toBeNull();
  });
});

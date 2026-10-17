import { describe, expect, test } from "bun:test";
import type { CompleteInput } from "../src/server/engine";
import { createMemory, estimateMessageTokens, estimateTokens, type Memory } from "../src/server/memory";
import { DEFAULT_TERA_ID, type Store } from "../src/server/store";
import type { ChatMessage } from "../src/shared/types";
import { makeStore } from "./support";

const HOUR_MS = 60 * 60 * 1000;
/** 記憶の引き金（3 時間）。実装と同じ値を使う。 */
const IDLE_MS = 3 * HOUR_MS;

/**
 * トークンの目安（半角 4 文字で 1 トークン）を狙って本文を作る。
 * 先頭には何番目のメッセージかが分かる番号を置く（観察へ渡る本文は切り詰められるので、頭に置く）。
 */
function body(tokens: number, index: number): string {
  return index.toString().padStart(8, "0") + "a".repeat(Math.max(0, tokens * 4 - 8));
}

/** ストアに、同じ大きさのメッセージを並べる（user と assistant が交互）。最後のメッセージの時刻を返す。 */
function seed(store: Store, tokensEach: number, count: number): number {
  let at = 0;
  for (let index = 1; index <= count; index += 1) {
    const message = store.appendMessage({
      id: `m${index}`,
      teraId: DEFAULT_TERA_ID,
      role: index % 2 === 1 ? "user" : "assistant",
      content: body(tokensEach, index),
    });
    at = message.createdAt;
  }
  return at;
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

/** テスト用の記憶。文脈長と時刻を決めて作る。 */
function memoryWith(
  store: Store,
  engine: Pick<MemoryEngine, "complete">,
  options: { limit?: number | null; now?: () => number; log?: (message: string) => void } = {},
): Memory {
  return createMemory({
    store,
    engine,
    log: options.log ?? (() => undefined),
    contextLimit: () => options.limit ?? null,
    now: options.now,
  });
}

type MemoryEngine = { complete(input: CompleteInput): Promise<string> };

/** 応答を待たせるための門。更新が重ならないことを確かめるのに使う。 */
function createGate() {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => open() };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("待機条件が満たされなかった");
}

describe("畳み始める時", () => {
  test("放置もされておらず、文脈長にも届かなければ、観察しない", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 5); // 5,000 トークン

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    const memory = memoryWith(store, fake.engine, { now: () => last });

    memory.check(DEFAULT_TERA_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fake.calls).toHaveLength(0);
    expect(memory.context(DEFAULT_TERA_ID).messages).toHaveLength(5);
    memory.close();
  });

  test("最後のやり取りから 3 時間たったら、記憶を作る", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 10); // 10,000 トークン（最後は assistant）

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    // 3 時間たった時刻に合わせる（予約はすぐ発火する）。
    const memory = memoryWith(store, fake.engine, { limit: 1_000_000, now: () => last + IDLE_MS });

    memory.check(DEFAULT_TERA_ID);
    await waitFor(() => store.readObservations(DEFAULT_TERA_ID).throughSeq > 0);
    await memory.update(DEFAULT_TERA_ID); // 走っている更新に合流して、終わりまで待つ

    expect(fake.calls.length).toBeGreaterThan(0);
    // 直近 6,000 トークン（6 件）は生のまま残る。
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(4);
    expect(memory.context(DEFAULT_TERA_ID).messages).toHaveLength(6);
    memory.close();
  });

  test("最後のやり取りから 3 時間たっていても、畳むものが無ければ何もしない", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 5); // 5,000 トークン（直近として残す分に収まる）

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    const memory = memoryWith(store, fake.engine, { limit: 1_000_000, now: () => last + IDLE_MS });

    memory.check(DEFAULT_TERA_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fake.calls).toHaveLength(0);
    expect(store.readObservations(DEFAULT_TERA_ID)).toEqual({ text: "", throughSeq: 0 });
    memory.close();
  });

  test("文脈長に届きそうなら、放置を待たずに畳む", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 10); // 10,000 トークン（最後は assistant）

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    // 10,000 トークンのモデルなので、10,000 は上限（7,500）を超えている。
    const memory = memoryWith(store, fake.engine, { limit: 10_000, now: () => last });

    memory.check(DEFAULT_TERA_ID);
    await memory.update(DEFAULT_TERA_ID);

    expect(fake.calls.length).toBeGreaterThan(0);
    // 直近 6,000 トークン（6 件）は生のまま残る。
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(4);
    expect(memory.context(DEFAULT_TERA_ID).messages).toHaveLength(6);
    memory.close();
  });

  test("文脈長に当たりそうにない長い履歴は、そのまま見せる", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 40); // 40,000 トークン（短い間にできた長い履歴）

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    // 1M トークンのモデルなら、この程度では上限に当たらない。
    const memory = memoryWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    memory.check(DEFAULT_TERA_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fake.calls).toHaveLength(0);
    expect(store.readObservations(DEFAULT_TERA_ID)).toEqual({ text: "", throughSeq: 0 });
    expect(memory.context(DEFAULT_TERA_ID).messages).toHaveLength(40);
    memory.close();
  });

  test("文脈長が分からないモデルは、既定の見積もり（12.8 万トークン）で見る", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 100); // 100,000 トークン > 128,000 の 75%

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    const memory = memoryWith(store, fake.engine, { limit: null, now: () => last });

    memory.check(DEFAULT_TERA_ID);
    await memory.update(DEFAULT_TERA_ID);

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(94);
    memory.close();
  });
});

describe("観察と反映", () => {
  test("返事がまだ返っていない発言は、畳まない", async () => {
    const store = makeStore();
    seed(store, 1_000, 8); // 最後は assistant
    store.appendMessage({
      id: "m9",
      teraId: DEFAULT_TERA_ID,
      role: "user",
      content: body(1_000, 9),
    });

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    const memory = memoryWith(store, fake.engine, { limit: 1_000_000 });

    await memory.update(DEFAULT_TERA_ID);

    // 9 件目（これからモデルが読む発言）は観察へ渡さない。
    const prompt = fake.calls[0]?.prompt ?? "";
    expect(prompt).toContain("00000001");
    expect(prompt).not.toContain("00000009");

    // 観察したのは 1・2 件目まで。残りは生のまま（9 件目を含む）。
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(2);
    expect(store.listMessagesSince(DEFAULT_TERA_ID, 2).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  test("記録が文脈長の 25% を超えたら、書き直して縮める", async () => {
    const store = makeStore();
    // 25,000 トークン（100,000 トークンのモデルの 25%）を超える記録。
    const log = `Date: 2026-10-16\n* 🔴 (09:00) ${"b".repeat(4 * 30_000)}`;
    store.writeObservations(DEFAULT_TERA_ID, { text: log, throughSeq: 7 });

    const fake = createMemoryEngine(() => "Date: 2026-10-16\n* 🔴 (09:00) 縮めた記録");
    const memory = memoryWith(store, fake.engine, { limit: 100_000, now: () => 0 });

    memory.check(DEFAULT_TERA_ID);
    await memory.update(DEFAULT_TERA_ID);

    // 反映には、いまの記録そのものが渡る（観察の呼び出しではない）。
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt).toBe(log);

    // 書き直しても、どこまで観察したかは動かさない。
    expect(store.readObservations(DEFAULT_TERA_ID)).toEqual({
      text: "Date: 2026-10-16\n* 🔴 (09:00) 縮めた記録",
      throughSeq: 7,
    });
    memory.close();
  });

  test("1 回の観察で見せるのは、文脈長の 25% まで", async () => {
    const store = makeStore();
    seed(store, 1_000, 200); // 200,000 トークン

    const fake = createMemoryEngine(() => "* 🔴 (09:00) 観察した");
    const memory = memoryWith(store, fake.engine, { limit: 100_000, now: () => 0 });

    await memory.update(DEFAULT_TERA_ID);

    // 100,000 トークンのモデルなので、1 回に見せるのは 25,000 トークン（25 件）まで。
    const prompt = fake.calls[0]?.prompt ?? "";
    expect(prompt).toContain("00000025");
    expect(prompt).not.toContain("00000026");

    // 何回かに分けて進み、直近 6 件は生のまま残る。
    expect(fake.calls.length).toBeGreaterThan(1);
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(194);
  });

  test("観察に失敗したら、記録は変えずに理由を出す", async () => {
    const store = makeStore();
    seed(store, 1_000, 40);

    const logs: string[] = [];
    const memory = memoryWith(
      store,
      { complete: () => Promise.reject(new Error("繋がらない")) },
      { log: (message) => void logs.push(message) },
    );

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
      const memory = memoryWith(store, { complete: () => Promise.resolve(reply) }, { log: (message) => void logs.push(message) });

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
    const memory = memoryWith(store, fake.engine, { limit: 1_000_000 });

    const first = memory.update(DEFAULT_TERA_ID);
    const second = memory.update(DEFAULT_TERA_ID);
    expect(second).toBe(first);

    gate.open();
    await first;

    expect(fake.calls).toHaveLength(1);
    expect(store.readObservations(DEFAULT_TERA_ID).throughSeq).toBe(34);
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

    const replies = [
      "Date: 2026-10-16\n* 🟡 (10:00) 足した記録",
      "Date: 2026-10-17\n* 🔴 (09:00) 別の日の記録",
      "Date: 2026-10-17\n* 🟢 (11:00) さらに足した記録",
    ];
    let index = 0;
    const memory = memoryWith(
      store,
      { complete: () => Promise.resolve(replies[index++] ?? "") },
      { limit: 100_000 },
    );

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

    const memory = memoryWith(store, { complete: () => Promise.resolve("") });

    expect(memory.context(DEFAULT_TERA_ID)).toEqual({
      observations: "* 🔴 (09:00) 観察した",
      messages: store.listMessagesSince(DEFAULT_TERA_ID, 2),
    });
  });

  test("まだ観察していなければ、記録は null", () => {
    const store = makeStore();
    seed(store, 1_000, 1);

    const memory = memoryWith(store, { complete: () => Promise.resolve("") });

    expect(memory.context(DEFAULT_TERA_ID).observations).toBeNull();
  });
});

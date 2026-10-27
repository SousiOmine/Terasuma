import { describe, expect, test } from "bun:test";
import { createCompaction, type Compaction } from "../src/server/conversation/compaction";
import { estimateMessageTokens, estimateTokens } from "../src/server/conversation/tokens";
import type { CompleteInput } from "../src/server/agent/engine";
import { DEFAULT_TERA_ID, DEFAULT_TERA_IDENTITY, type Store } from "../src/server/data/store";
import type { ChatMessage, MessagePart } from "../src/shared/api/message";
import { makeStore } from "./support";

const HOUR_MS = 60 * 60 * 1000;
/** 放置の引き金（3 時間）。実装と同じ値を使う。 */
const IDLE_MS = 3 * HOUR_MS;

/** 要約として使える定型。 */
const SUMMARY = "## Goal\n古いやり取りを畳んだ。\n\n## Progress\n### In Progress\n- [ ] 続きを待つ";

/**
 * トークンの目安（半角 4 文字で 1 トークン）を狙って本文を作る。
 * 先頭には何番目のメッセージかが分かる印を置く（要約へ渡る本文の頭に来る）。
 */
function body(tokens: number, label: string): string {
  const head = `[${label}]`;
  return head + "a".repeat(Math.max(0, tokens * 4 - head.length));
}

/**
 * ストアに、同じ大きさのメッセージを並べる（user と assistant が交互）。
 * 最後のメッセージの時刻を返す。
 */
function seed(store: Store, tokensEach: number, count: number): number {
  let at = 0;
  for (let index = 1; index <= count; index += 1) {
    const content = body(tokensEach, `m${index}`);
    const role = index % 2 === 1 ? "user" : "assistant";
    const parts: MessagePart[] | null = role === "assistant" ? [{ type: "text", text: content, at: index }] : null;
    const message = store.appendMessage({
      id: `m${index}`,
      teraId: DEFAULT_TERA_ID,
      role,
      content: role === "user" ? content : "",
      parts,
    });
    at = message.createdAt;
  }
  return at;
}

/** メッセージを 1 件ずつ、役割とトークン数を決めて並べる。 */
function seedMessages(store: Store, plan: readonly (readonly [role: "user" | "assistant", tokens: number])[]): number {
  let at = 0;
  for (const [index, [role, tokens]] of plan.entries()) {
    const content = body(tokens, `p${index + 1}`);
    const parts: MessagePart[] | null = role === "assistant" ? [{ type: "text", text: content, at: index }] : null;
    const message = store.appendMessage({
      id: `p${index + 1}`,
      teraId: DEFAULT_TERA_ID,
      role,
      content: role === "user" ? content : "",
      parts,
    });
    at = message.createdAt;
  }
  return at;
}

/** complete の呼び出しを記録し、決めた応答を返すエンジン。 */
function createEngine(reply: (input: CompleteInput) => string | Promise<string>) {
  const calls: CompleteInput[] = [];
  return {
    calls,
    engine: {
      complete(input: CompleteInput): Promise<string> {
        calls.push(input);
        return Promise.resolve().then(() => reply(input));
      },
    },
  };
}

/** テスト用の圧縮。文脈長と時刻を決めて作る。 */
function compactionWith(
  store: Store,
  engine: Pick<ReturnType<typeof createEngine>["engine"], "complete">,
  options: { limit?: number | null; now?: () => number; log?: (message: string) => void } = {},
): Compaction {
  return createCompaction({
    store,
    engine,
    log: options.log ?? (() => undefined),
    contextLimit: () => options.limit ?? null,
    now: options.now,
  });
}

/** 応答を待たせるための門。更新が重ならないことを確かめるのに使う。 */
function createGate() {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => open() };
}

/**
 * 中断されたときだけ失敗する、終わらない応答。
 * Tera を消すときに、走っている畳みを打ち切れることを確かめるのに使う。
 */
function cancelableSummary(signal: AbortSignal): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("待機条件が満たされなかった");
}

/** 待ちを 1 度だけ回す（走っている更新が進むのを待つ）。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("畳み始める時", () => {
  test("文脈長に届いていなければ、放置もされていなければ、畳まない", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 5); // 5,000 トークン

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    compaction.check(DEFAULT_TERA_ID);
    await tick();

    expect(fake.calls).toHaveLength(0);
    expect(store.readCompaction(DEFAULT_TERA_ID).summary).toBe("");
    compaction.close();
  });

  test("最後のやり取りから 3 時間たったら、閾値に届いていなくても畳む", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 30); // 30,000 トークン

    const fake = createEngine(() => SUMMARY);
    // 3 時間たった時刻に合わせる（予約はすぐ発火する）。
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last + IDLE_MS });

    compaction.check(DEFAULT_TERA_ID);
    await waitFor(() => store.readCompaction(DEFAULT_TERA_ID).throughSeq > 0);
    await compaction.update(DEFAULT_TERA_ID);

    expect(fake.calls.length).toBeGreaterThan(0);
    // 直近 20,000 トークン（20 件）は生のまま残る。
    expect(store.readCompaction(DEFAULT_TERA_ID).throughSeq).toBe(10);
    expect(store.listMessagesSince(DEFAULT_TERA_ID, 10)).toHaveLength(20);
    compaction.close();
  });

  test("放っておいても、畳むものが無ければ何もしない", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 5); // 5,000 トークン（直近として残す分に収まる）

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last + IDLE_MS });

    compaction.check(DEFAULT_TERA_ID);
    await tick();

    expect(fake.calls).toHaveLength(0);
    expect(store.readCompaction(DEFAULT_TERA_ID).summary).toBe("");
    compaction.close();
  });

  test("文脈長に近づいたら、放置を待たずに畳む", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 15); // 15,000 トークン

    const fake = createEngine(() => SUMMARY);
    // 30,000 トークンのモデルなら、閾値は 30,000 - 16,384 = 13,616。
    const compaction = compactionWith(store, fake.engine, { limit: 30_000, now: () => last });

    compaction.check(DEFAULT_TERA_ID);
    await compaction.update(DEFAULT_TERA_ID);

    expect(fake.calls.length).toBeGreaterThan(0);
    // 直近として残すのは使える文脈の半分（6,808 トークン）。1,000 トークン×7 件になる。
    expect(store.readCompaction(DEFAULT_TERA_ID).throughSeq).toBe(8);
    expect(store.listMessagesSince(DEFAULT_TERA_ID, 8)).toHaveLength(7);
    compaction.close();
  });

  test("文脈長に当たりそうにない長い履歴は、そのまま見せる", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 40); // 40,000 トークン

    const fake = createEngine(() => SUMMARY);
    // 1M トークンのモデルなら、この程度では閾値に届かない。
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    compaction.check(DEFAULT_TERA_ID);
    await tick();

    expect(fake.calls).toHaveLength(0);
    expect(store.readCompaction(DEFAULT_TERA_ID).summary).toBe("");
    expect(store.listMessagesSince(DEFAULT_TERA_ID, 0)).toHaveLength(40);
    compaction.close();
  });

  test("文脈長が分からないモデルは、既定の見積もり（12.8 万トークン）で見る", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 120); // 120,000 トークン > 128,000 - 16,384

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: null, now: () => last });

    compaction.check(DEFAULT_TERA_ID);
    await compaction.update(DEFAULT_TERA_ID);

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(store.readCompaction(DEFAULT_TERA_ID).throughSeq).toBe(100);
    compaction.close();
  });

  test("直前の呼び出しの usage があれば、文字数より先にそれで閾値を見る", async () => {
    const store = makeStore();
    // 文字数からは 7,500 トークンにしかならない履歴。
    seed(store, 1_000, 29);
    const last = store.appendMessage({
      id: "m30",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [{ type: "text", text: body(1_000, "m30"), at: 1 }],
      usage: { inputTokens: 20_000, outputTokens: 500, cachedInputTokens: 0 },
    }).createdAt;

    const fake = createEngine(() => SUMMARY);
    // 文字数だけで見れば閾値（15,616）に届かない。usage で見れば超えている。
    const compaction = compactionWith(store, fake.engine, { limit: 32_000, now: () => last + 1 });

    compaction.check(DEFAULT_TERA_ID);
    await compaction.update(DEFAULT_TERA_ID);

    expect(fake.calls.length).toBeGreaterThan(0);
    compaction.close();
  });

  test("畳んだ直後は、圧縮前の usage でまた畳まない", async () => {
    const store = makeStore();
    seed(store, 1_000, 29);
    const last = store.appendMessage({
      id: "m30",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [{ type: "text", text: body(1_000, "m30"), at: 1 }],
      usage: { inputTokens: 20_000, outputTokens: 500, cachedInputTokens: 0 },
    }).createdAt;

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 32_000, now: () => last + 1 });

    await compaction.update(DEFAULT_TERA_ID, { force: true });
    const afterFirst = fake.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // 残した履歴には、畳む前の広い usage が付いたまま。
    // それをそのまま使うと、畳んだ直後にもう一度畳もうとしてしまう。
    compaction.check(DEFAULT_TERA_ID);
    await tick();

    expect(fake.calls).toHaveLength(afterFirst);
    compaction.close();
  });
});

describe("切れ目の決め方", () => {
  test("直近は生のまま残り、切れ目は user 発言に揃う", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 30); // 30,000 トークン

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    await compaction.update(DEFAULT_TERA_ID, { force: true });

    const kept = store.listMessagesSince(DEFAULT_TERA_ID, store.readCompaction(DEFAULT_TERA_ID).throughSeq);
    expect(kept).toHaveLength(20);
    // 生の履歴は user から始まる（プロバイダの役割の並びを崩さないため）。
    expect(kept[0]?.role).toBe("user");
    expect(kept[0]?.seq).toBe(11);
    compaction.close();
  });

  test("1 ターンが直近の予算を超えたら、履歴とターン前半の 2 回に分けて要約する", async () => {
    const store = makeStore();
    const last = seedMessages(store, [
      ["user", 1_000],
      ["assistant", 1_000],
      ["user", 1_000],
      ["assistant", 1_000],
      ["user", 1_000], // ここからが大きなターン
      ["assistant", 10_000],
      ["assistant", 10_000],
      ["assistant", 10_000],
    ]);

    const fake = createEngine((input) =>
      input.prompt.includes("## Original Request") ? "## Original Request\n長いターンの前半。" : SUMMARY,
    );
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    await compaction.update(DEFAULT_TERA_ID, { force: true });

    expect(fake.calls).toHaveLength(2);
    // 履歴（p1〜p4）とターン前半（p5〜p6）が、それぞれ別の呼び出しに載る。
    const prompts = fake.calls.map((call) => call.prompt).join("\n---\n");
    expect(prompts).toContain("[p1]");
    expect(prompts).toContain("[p5]");
    expect(prompts).toContain("## Original Request");

    const state = store.readCompaction(DEFAULT_TERA_ID);
    expect(state.summary).toContain("古いやり取りを畳んだ");
    expect(state.summary).toContain("**Turn Context (split turn):**");
    expect(state.summary).toContain("長いターンの前半");
    // 生のまま残るのは p7・p8。
    expect(state.throughSeq).toBe(6);
    compaction.close();
  });
});

describe("要約の作り方", () => {
  test("前の要約があるときは、それを渡して書き直す", async () => {
    const store = makeStore();
    store.writeCompaction(DEFAULT_TERA_ID, {
      summary: "## Goal\n前からある要約。",
      throughSeq: 0,
      tokensBefore: 0,
      createdAt: 1,
    });
    const last = seed(store, 1_000, 30);

    const fake = createEngine((input) =>
      input.prompt.includes("<previous-summary>") ? "## Goal\n書き直した要約。" : "",
    );
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    await compaction.update(DEFAULT_TERA_ID, { force: true });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt).toContain("<previous-summary>");
    expect(fake.calls[0]?.prompt).toContain("前からある要約。");
    expect(store.readCompaction(DEFAULT_TERA_ID).summary).toBe("## Goal\n書き直した要約。");
    compaction.close();
  });

  test("長い履歴は、1 回に載せる量を区切って畳む", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 300); // 300,000 トークン

    const fake = createEngine(() => SUMMARY);
    // 100,000 トークンのモデル。1 回に載せるのは 50,000 トークン（50 件）。
    const compaction = compactionWith(store, fake.engine, { limit: 100_000, now: () => last });

    await compaction.update(DEFAULT_TERA_ID, { force: true });

    // 畳むのは p1〜p280 の 280 件。50 件ずつで 5 回、残り 30 件で 1 回。
    expect(fake.calls).toHaveLength(6);
    // 2 回目からは、それまでの要約を渡して書き直す。
    expect(fake.calls[1]?.prompt).toContain("<previous-summary>");
    expect(store.readCompaction(DEFAULT_TERA_ID).throughSeq).toBe(280);
    compaction.close();
  });

  test("畳む範囲は、要約に載せる形に直してから渡す", async () => {
    const store = makeStore();
    const at = Date.now();
    store.appendMessage({
      id: "u1",
      teraId: DEFAULT_TERA_ID,
      role: "user",
      content: body(6_000, "u1"),
    });
    store.appendMessage({
      id: "a1",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "調べます。",
      parts: [
        { type: "text", text: "調べます。", at },
        { type: "tool-call", id: "call-1", server: "", tool: "bash", args: { command: "uname -a" } },
        {
          type: "tool-result",
          id: "call-1",
          server: "",
          tool: "bash",
          failed: false,
          output: "Linux terasuma 7.0.0\n".repeat(400),
          images: [{ sha256: "0".repeat(64), mime: "image/png", width: 1280, height: 800 }],
        },
      ],
    });
    store.appendMessage({
      id: "u2",
      teraId: DEFAULT_TERA_ID,
      role: "user",
      content: body(15_000, "u2"),
    });

    const fake = createEngine(() => SUMMARY);
    // p1・p2 を畳む。直近（p3）は生のまま残る。
    const compaction = compactionWith(store, fake.engine, { limit: 32_000, now: () => at });

    await compaction.update(DEFAULT_TERA_ID, { force: true });
    const prompt = fake.calls[0]?.prompt ?? "";

    expect(prompt).toContain("[User]: ");
    expect(prompt).toContain("[Assistant]: 調べます。");
    expect(prompt).toContain('[Assistant tool calls]: bash(command="uname -a")');
    expect(prompt).toContain("[Tool result]: Linux terasuma");
    // 長い結果は切る。画像は中身を渡さず、大きさだけ残す。
    expect(prompt).toContain("more characters truncated");
    expect(prompt).toContain("[image 1280x800]");
    compaction.close();
  });

  test("添付は要約に渡さず、本文は渡す", async () => {
    const store = makeStore();
    const at = Date.now();
    store.appendMessage({ id: "u1", teraId: DEFAULT_TERA_ID, role: "user", content: body(6_000, "u1") });
    store.appendMessage({
      id: "a1",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [
        { type: "text", text: "送った文", at },
        { type: "tool-call", id: "call-1", server: "chat", tool: "attach", args: { files: ["x.png"] } },
        {
          type: "tool-result",
          id: "call-1",
          server: "chat",
          tool: "attach",
          failed: false,
          output: "Attached 1 file to the chat.",
        },
        {
          type: "attachment",
          attachments: [{ name: "x.png", size: 3, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
          at,
        },
      ],
    });
    store.appendMessage({ id: "u2", teraId: DEFAULT_TERA_ID, role: "user", content: body(15_000, "u2") });

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 32_000, now: () => at });

    await compaction.update(DEFAULT_TERA_ID, { force: true });
    const prompt = fake.calls[0]?.prompt ?? "";

    // 本文はそのまま載り、添付の参照は載らない。
    expect(prompt).toContain("[Assistant]: 送った文");
    expect(prompt).toContain('[Assistant tool calls]: chat_attach(files=["x.png"])');
    expect(prompt).not.toContain("/api/images/x.png");
    compaction.close();
  });
});

describe("失敗したとき", () => {
  test("要約に失敗したら、状態は変えず、理由を出す", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 30);

    const logs: string[] = [];
    const fake = createEngine(() => Promise.reject(new Error("繋がらない")));
    const compaction = compactionWith(store, fake.engine, {
      limit: 1_000_000,
      now: () => last,
      log: (message) => void logs.push(message),
    });

    await compaction.update(DEFAULT_TERA_ID, { force: true });

    const state = store.readCompaction(DEFAULT_TERA_ID);
    expect(state.summary).toBe("");
    expect(state.throughSeq).toBe(0);
    expect(logs.join("\n")).toContain("繋がらない");
    // 畳んでいない分は生のまま渡るので、内容は失われない。
    expect(store.listMessagesSince(DEFAULT_TERA_ID, 0)).toHaveLength(30);
    compaction.close();
  });

  test("中身の無い要約は、状態を進めない", async () => {
    for (const reply of ["", "   \n", "見出しの無い要約です。"]) {
      const store = makeStore();
      const last = seed(store, 1_000, 30);

      const logs: string[] = [];
      const fake = createEngine(() => reply);
      const compaction = compactionWith(store, fake.engine, {
        limit: 1_000_000,
        now: () => last,
        log: (message) => void logs.push(message),
      });

      await compaction.update(DEFAULT_TERA_ID, { force: true });

      // 中身が無いまま進めると、畳んだはずのやり取りがどこにも残らなくなる。
      expect(store.readCompaction(DEFAULT_TERA_ID)).toEqual({
        summary: "",
        throughSeq: 0,
        tokensBefore: 0,
        createdAt: 0,
      });
      expect(logs.join("\n")).toContain("要約");
      compaction.close();
    }
  });

  test("同じ Tera の更新は重ねて走らせない", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 30);

    const gate = createGate();
    let started = 0;
    const fake = createEngine(async () => {
      started += 1;
      await gate.gate;
      return SUMMARY;
    });
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    const first = compaction.update(DEFAULT_TERA_ID, { force: true });
    await waitFor(() => started === 1);
    const second = compaction.update(DEFAULT_TERA_ID, { force: true });
    expect(second).toBe(first);

    gate.open();
    await first;

    expect(started).toBe(1);
    expect(store.readCompaction(DEFAULT_TERA_ID).throughSeq).toBe(10);
    compaction.close();
  });
});

describe("identity の切り替え", () => {
  test("要約を書き換えたら、書いてあった identity を system プロンプト用に切り替える", async () => {
    const store = makeStore();
    store.writeIdentity(DEFAULT_TERA_ID, "# Role\n新しい役割");
    const last = seed(store, 1_000, 30);

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    await compaction.update(DEFAULT_TERA_ID, { force: true });

    expect(store.readIdentity(DEFAULT_TERA_ID)).toEqual({
      content: "# Role\n新しい役割",
      applied: "# Role\n新しい役割",
    });
    compaction.close();
  });

  test("畳むものが無ければ、identity は切り替えない", async () => {
    const store = makeStore();
    store.writeIdentity(DEFAULT_TERA_ID, "# Role\n新しい役割");
    const last = seed(store, 1_000, 5);

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    // 放置の引き金（force）でも、要約を書き換えなければ切り替えない。
    await compaction.update(DEFAULT_TERA_ID, { force: true });

    expect(fake.calls).toHaveLength(0);
    expect(store.readIdentity(DEFAULT_TERA_ID).applied).toBe(DEFAULT_TERA_IDENTITY);
    compaction.close();
  });

  test("閾値に届いていなければ、identity は切り替えない", async () => {
    const store = makeStore();
    store.writeIdentity(DEFAULT_TERA_ID, "# Role\n新しい役割");
    const last = seed(store, 1_000, 5);

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    await compaction.update(DEFAULT_TERA_ID);

    expect(fake.calls).toHaveLength(0);
    expect(store.readIdentity(DEFAULT_TERA_ID).applied).toBe(DEFAULT_TERA_IDENTITY);
    compaction.close();
  });

  test("要約に失敗したら、identity は切り替えない", async () => {
    const store = makeStore();
    store.writeIdentity(DEFAULT_TERA_ID, "# Role\n新しい役割");
    const last = seed(store, 1_000, 30);

    const fake = createEngine(() => Promise.reject(new Error("繋がらない")));
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    await compaction.update(DEFAULT_TERA_ID, { force: true });

    expect(store.readIdentity(DEFAULT_TERA_ID).applied).toBe(DEFAULT_TERA_IDENTITY);
    compaction.close();
  });
});

describe("文脈の組み立て", () => {
  test("走っている圧縮があれば、終わるまで待ってから文脈を返す", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 30);

    const gate = createGate();
    const fake = createEngine(async () => {
      await gate.gate;
      return SUMMARY;
    });
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    const job = compaction.update(DEFAULT_TERA_ID, { force: true });
    const pending = compaction.context(DEFAULT_TERA_ID, new AbortController().signal);

    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);

    gate.open();
    const context = await pending;
    await job;

    expect(context.summary).toContain("古いやり取りを畳んだ");
    expect(context.messages).toHaveLength(20);
    compaction.close();
  });

  test("ターンが止まったら、圧縮を待たずにいまの文脈を返す", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 30);

    const gate = createGate();
    const fake = createEngine(async () => {
      await gate.gate;
      return SUMMARY;
    });
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000, now: () => last });

    const job = compaction.update(DEFAULT_TERA_ID, { force: true });
    const controller = new AbortController();
    controller.abort();

    const context = await compaction.context(DEFAULT_TERA_ID, controller.signal);
    expect(context.summary).toBeNull();
    expect(context.messages).toHaveLength(30);

    gate.open();
    await job;
    compaction.close();
  });
});

describe("削除に備えて止める", () => {
  test("cancel は走っている畳みを打ち切り、要約を書かずに終わる", async () => {
    const store = makeStore();
    seed(store, 1_000, 30);

    const logs: string[] = [];
    const fake = createEngine((input) => cancelableSummary(input.signal));
    const compaction = compactionWith(store, fake.engine, {
      limit: 1_000_000,
      log: (message) => logs.push(message),
    });

    const job = compaction.update(DEFAULT_TERA_ID, { force: true });
    // 要約の呼び出しが始まる（＝走っている）まで待つ。
    await waitFor(() => fake.calls.length > 0);

    await compaction.cancel(DEFAULT_TERA_ID);
    await job;

    expect(store.readCompaction(DEFAULT_TERA_ID).summary).toBe("");
    expect(logs.some((line) => line.includes("削除されたため打ち切りました"))).toBe(true);
    compaction.close();
  });

  test("cancel は予約も外す（予約した畳みは走らない）", async () => {
    const store = makeStore();
    const last = seed(store, 1_000, 5);

    const fake = createEngine(() => SUMMARY);
    // 20ms 後に畳む予約になる時刻にする。
    const compaction = compactionWith(store, fake.engine, {
      limit: 1_000_000,
      now: () => last + IDLE_MS - 20,
    });

    compaction.check(DEFAULT_TERA_ID);
    await compaction.cancel(DEFAULT_TERA_ID);
    await tick();
    await tick();

    expect(fake.calls).toHaveLength(0);
    expect(store.readCompaction(DEFAULT_TERA_ID).summary).toBe("");
    compaction.close();
  });

  test("走っている畳みが無ければ、cancel は何もしない", async () => {
    const store = makeStore();
    seed(store, 1_000, 5);

    const fake = createEngine(() => SUMMARY);
    const compaction = compactionWith(store, fake.engine, { limit: 1_000_000 });

    await compaction.cancel(DEFAULT_TERA_ID);

    expect(fake.calls).toHaveLength(0);
    compaction.close();
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

  test("ツールの結果と画像も数え、画面にだけ出す部分は数えない", () => {
    const message: ChatMessage = {
      id: "m1",
      teraId: DEFAULT_TERA_ID,
      seq: 1,
      role: "assistant",
      content: "",
      attachments: null,
      origin: null,
      parts: [
        // 画面にだけ出す添付と注記は、モデルへ渡さないので数えない。
        {
          type: "attachment",
          attachments: [{ name: "x.png", size: 3, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
          at: 1,
        },
        { type: "notice", text: "止まりました", at: 2 },
        { type: "text", text: "abcd", at: 3 }, // 1
        { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: "abcd" }, // """abcd""" で 2
        {
          type: "tool-result",
          id: "call-1",
          server: "local",
          tool: "echo",
          failed: false,
          output: "abcdefgh", // 2
          images: [{ sha256: "0".repeat(64), mime: "image/png", width: 1280, height: 800 }], // 画像 1 枚分
        },
      ],
      createdAt: 0,
      usage: null,
    };

    expect(estimateMessageTokens(message)).toBe(1 + 2 + 2 + 1_000);

    // ユーザーの発言は parts を持たず、本文（添付の案内も含む）だけを数える。
    expect(
      estimateMessageTokens({
        ...message,
        role: "user",
        content: "abcd",
        parts: null,
      }),
    ).toBe(1);
  });
});

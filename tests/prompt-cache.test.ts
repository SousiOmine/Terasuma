import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageStore } from "../src/server/images";
import {
  summaryText,
  buildModelInput,
  replyLanguageInstruction,
  SYSTEM_PROMPT,
  type ImageReader,
  type TeraContext,
} from "../src/server/prompt";
import { readContext } from "../src/server/compaction";
import { DEFAULT_TERA_ID } from "../src/server/store";
import type { ImageRef } from "../src/shared/types";
import { createImageStub, makeStore, testPng } from "./support";

/**
 * モデルへ渡る文脈。要約はストアに置かれたものをそのまま使う（本番と同じ組み立てを通す）。
 */
function contextOf(store: ReturnType<typeof makeStore>): TeraContext {
  return readContext(store, DEFAULT_TERA_ID);
}

/** このテストの会話は日本語なので、返事の言語は ja に固定する。 */
function buildInput(context: TeraContext, images: ImageReader) {
  return buildModelInput(context, images, "ja");
}

/** 入力の末尾に必ず 1 件足される、返事の言語の指示。 */
const LANGUAGE_MESSAGE = { role: "user", content: replyLanguageInstruction("ja") } as const;

/**
 * プロンプトキャッシュは、リクエストの先頭が前回と一致するほど当たる。
 * ここが変わると気づかないうちにコストが増えるだけで分かりにくいため、テストで常に確認する。
 * 先頭は「system プロンプト → 畳んだ要約（user メッセージ）」、そのうしろに生の履歴が続く。
 */
describe("プロンプトキャッシュ保護", () => {
  test("入力の先頭は常に system プロンプト 1 件", () => {
    expect(buildInput({ summary: null, messages: [] }, createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      LANGUAGE_MESSAGE,
    ]);
  });

  test("履歴は保存された順にそのまま並ぶ", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "質問" });
    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "回答" });

    expect(buildInput(contextOf(store), createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "質問" },
      { role: "assistant", content: "回答" },
      LANGUAGE_MESSAGE,
    ]);
  });

  test("同じ履歴からは常に同じ入力が組み立てられる", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "質問" });

    // 日時や件数などを混ぜると、ここで差分が出てテストが失敗する。
    expect(buildInput(contextOf(store), createImageStub())).toEqual(buildInput(contextOf(store), createImageStub()));
  });

  test("次のターンの入力は、前のターンの入力で始まる", () => {
    const store = makeStore();

    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "最初の質問" });
    const turn1 = buildInput(contextOf(store), createImageStub());

    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "最初の回答" });
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "次の質問" });
    const turn2 = buildInput(contextOf(store), createImageStub());

    // 末尾の言語の指示はターンごとに位置が変わる。その手前（保存済みの履歴）が
    // 前のターンと一致していることが、キャッシュの当たる条件になる。
    const stable1 = turn1.slice(0, -1);
    const stable2 = turn2.slice(0, -1);
    expect(stable2.slice(0, stable1.length)).toEqual(stable1);
    // シリアライズしたバイト列としても接頭辞になっていること。
    expect(JSON.stringify(stable2).startsWith(JSON.stringify(stable1).slice(0, -1))).toBe(true);
  });
});

describe("ツールを使ったターンの入力", () => {
  /** ツールを 1 回使った 1 ターン分の履歴。 */
  function toolHistory(store: ReturnType<typeof makeStore>) {
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "調べて" });
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "調べます。",
      parts: [
        { type: "text", text: "調べます。" },
        { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
        { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
      ],
    });
  }

  test("呼び出しと結果は assistant と tool の 2 件に開かれる", () => {
    const store = makeStore();
    toolHistory(store);

    expect(buildInput(contextOf(store), createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "調べて" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "調べます。" },
          { type: "tool-call", toolCallId: "call-1", toolName: "local_echo", input: { text: "hi" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "local_echo",
            output: { type: "text", value: "echo: hi" },
          },
        ],
      },
      LANGUAGE_MESSAGE,
    ]);
  });

  test("結果が残らなかった呼び出しは、中断したことを伝える", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "調べて" });
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [{ type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } }],
    });

    const input = buildInput(contextOf(store), createImageStub());
    expect(input[3]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "local_echo",
          output: { type: "error-text", value: "This tool call was interrupted before it returned a result." },
        },
      ],
    });
  });

  test("失敗したツールの結果は error-text として渡す", () => {
    const store = makeStore();
    toolHistory(store);
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "もう一度" });
    store.appendMessage({
      id: "m4",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [
        { type: "tool-call", id: "call-2", server: "local", tool: "fail", args: { reason: "test" } },
        { type: "tool-result", id: "call-2", server: "local", tool: "fail", failed: true, output: "失敗: test" },
      ],
    });

    const input = buildInput(contextOf(store), createImageStub());
    // 末尾は言語の指示なので、その 1 つ前が最後のツールの結果になる。
    expect(input.at(-2)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-2",
          toolName: "local_fail",
          output: { type: "error-text", value: "失敗: test" },
        },
      ],
    });
  });

  test("ツールを使った後も、次の入力は前の入力で始まる", () => {
    const store = makeStore();
    toolHistory(store);
    const turn1 = buildInput(contextOf(store), createImageStub());

    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "次の質問" });
    const turn2 = buildInput(contextOf(store), createImageStub());

    const stable1 = turn1.slice(0, -1);
    const stable2 = turn2.slice(0, -1);
    expect(stable2.slice(0, stable1.length)).toEqual(stable1);
    expect(JSON.stringify(stable2).startsWith(JSON.stringify(stable1).slice(0, -1))).toBe(true);
  });
});

describe("返事の言語", () => {
  test("設定した言語の指示を、入力の末尾に 1 件だけ置く", () => {
    const ja = buildModelInput({ summary: null, messages: [] }, createImageStub(), "ja");
    const en = buildModelInput({ summary: null, messages: [] }, createImageStub(), "en");

    expect(ja.at(-1)).toEqual(LANGUAGE_MESSAGE);
    expect(en.at(-1)).toEqual({ role: "user", content: replyLanguageInstruction("en") });
    expect(replyLanguageInstruction("ja")).toContain("Japanese");
    expect(replyLanguageInstruction("en")).toContain("English");
  });
});

describe("画像つきのツール結果", () => {
  /** 画面を撮ったことにして、画像つきの結果を 1 つ持つ履歴を作る。 */
  function screenshotHistory(result: { image?: ImageRef }) {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "画面を見て" });
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "見ます。",
      parts: [
        { type: "text", text: "見ます。" },
        { type: "tool-call", id: "call-1", server: "computer", tool: "screenshot", args: {} },
        {
          type: "tool-result",
          id: "call-1",
          server: "computer",
          tool: "screenshot",
          failed: false,
          output: "The screen is 1280x800 pixels.",
          ...(result.image === undefined ? {} : { image: result.image }),
        },
      ],
    });
    return contextOf(store);
  }

  test("結果は本文で渡し、画像は続く user メッセージで渡す", () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-prompt-"));
    const images = createImageStore(dir);
    const png = testPng(1280, 800);

    try {
      const ref = images.save(png, "image/png");
      const input = buildInput(screenshotHistory({ image: ref }), images);

      // tool の本文に画像は置けない（OpenAI 互換のプロバイダが文字列へ潰すため）。
      // 結果はテキストで渡し、画像はその直後の user メッセージで渡す。
      expect(input[3]).toEqual({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "computer_screenshot",
            output: { type: "text", value: "The screen is 1280x800 pixels." },
          },
        ],
      });

      expect(input[4]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "(screen image from the computer_screenshot call)" },
          { type: "image", image: png, mediaType: "image/png" },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("同じ画面なら、組み立てた入力も同じ（キャッシュが当たり続ける）", () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-prompt-"));
    const images = createImageStore(dir);

    try {
      // 撮り直しても同じ中身なら同じ参照になるので、渡る画像も同じになる。
      const first = images.save(testPng(1280, 800), "image/png");
      const second = images.save(testPng(1280, 800), "image/png");

      expect(buildInput(screenshotHistory({ image: second }), images)).toEqual(
        buildInput(screenshotHistory({ image: first }), images),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("実体が無ければ、黙って画像を落とさずに本文へ書く", () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-prompt-"));
    const images = createImageStore(dir);
    const missing: ImageRef = { sha256: "0".repeat(64), mime: "image/png", width: 1280, height: 800 };

    try {
      const input = buildInput(screenshotHistory({ image: missing }), images);
      expect(input[3]).toEqual({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "computer_screenshot",
            output: {
              type: "text",
              value: "The screen is 1280x800 pixels.\n(Could not read the stored image.)",
            },
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 畳んだ要約を渡すときの並び。要約は system プロンプトの直後に user メッセージで 1 件だけ置き、
 * そこから先は生の履歴が続く。要約は圧縮のたびに書き直されるが、その間は変わらない。
 */
describe("畳んだ要約を渡すとき", () => {
  /** 要約を 1 つ持ち、そこまでの履歴を畳んだストア。 */
  function storeWithSummary(summary: string, throughSeq: number): ReturnType<typeof makeStore> {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "京都に住んでいます" });
    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "承知しました" });
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "次の質問" });
    store.writeCompaction(DEFAULT_TERA_ID, { summary, throughSeq, tokensBefore: 1_000, createdAt: 1 });
    return store;
  }

  const SUMMARY = "## Goal\n京都に住んでいる。";

  test("要約は、system プロンプトの直後に user メッセージ 1 件として置く", () => {
    expect(buildInput(contextOf(storeWithSummary(SUMMARY, 2)), createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: summaryText(SUMMARY) },
      { role: "user", content: "次の質問" },
      LANGUAGE_MESSAGE,
    ]);
  });

  test("畳んだメッセージは、生の履歴には残らない", () => {
    const input = buildInput(contextOf(storeWithSummary(SUMMARY, 2)), createImageStub());
    expect(input.some((message) => JSON.stringify(message).includes("京都に住んでいます"))).toBe(false);

    // まだ畳んでいない分は生のまま残る。
    const pending = buildInput(contextOf(storeWithSummary(SUMMARY, 0)), createImageStub());
    expect(pending.some((message) => JSON.stringify(message).includes("京都に住んでいます"))).toBe(true);
  });

  test("要約が変わらなければ、次のターンの入力は前のターンで始まる", () => {
    const store = storeWithSummary(SUMMARY, 2);
    const turn1 = buildInput(contextOf(store), createImageStub());

    store.appendMessage({ id: "m4", teraId: DEFAULT_TERA_ID, role: "assistant", content: "回答" });
    store.appendMessage({ id: "m5", teraId: DEFAULT_TERA_ID, role: "user", content: "さらに質問" });
    const turn2 = buildInput(contextOf(store), createImageStub());

    const stable1 = turn1.slice(0, -1);
    const stable2 = turn2.slice(0, -1);
    expect(stable2.slice(0, stable1.length)).toEqual(stable1);
    expect(JSON.stringify(stable2).startsWith(JSON.stringify(stable1).slice(0, -1))).toBe(true);
  });

  test("要約の前置きは定数で、日時や件数を混ぜない", () => {
    const first = summaryText("## Goal\n一つ目の要約。");
    const second = summaryText("## Goal\n二つ目の要約。");
    const head = first.slice(0, first.indexOf("## Goal"));

    expect(second.startsWith(head)).toBe(true);
  });
});

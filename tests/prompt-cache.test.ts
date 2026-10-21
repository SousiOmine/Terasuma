import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageStore, type ImageReader } from "../src/server/computer/images";
import {
  summaryText,
  buildModelInput,
  replyLanguageInstruction,
  SYSTEM_PROMPT,
  turnTail,
  type TeraContext,
} from "../src/server/agent/prompt";
import { readContext } from "../src/server/agent/compaction";
import { DEFAULT_TERA_ID } from "../src/server/data/store";
import type { ImageRef } from "../src/shared/types";
import { createImageStub, makeStore, testPng } from "./support";

/**
 * モデルへ渡る文脈。要約はストアに置かれたものをそのまま使う（本番と同じ組み立てを通す）。
 */
function contextOf(store: ReturnType<typeof makeStore>): TeraContext {
  return readContext(store, DEFAULT_TERA_ID);
}

/** 今日の日付を固定する時刻。テストが日付の変わり目で揺れないようにする。 */
const NOW = new Date(2026, 9, 21, 12, 0).getTime();

/** このテストの会話は日本語なので、返事の言語は ja に固定する。 */
function buildInput(context: TeraContext, images: ImageReader) {
  return buildModelInput(context, images, "ja", { toolResultImages: true }, NOW);
}

/** 入力の末尾に必ず 1 件足される、返事の言語と今日の日付。 */
const TAIL_MESSAGE = { role: "user", content: turnTail("ja", NOW) } as const;

/**
 * プロンプトキャッシュは、リクエストの先頭が前回と一致するほど当たる。
 * ここが変わると気づかないうちにコストが増えるだけで分かりにくいため、テストで常に確認する。
 * 先頭は「system プロンプト → 畳んだ要約（user メッセージ）」、そのうしろに生の履歴が続く。
 */
describe("プロンプトキャッシュ保護", () => {
  test("入力の先頭は常に system プロンプト 1 件", () => {
    expect(buildInput({ summary: null, messages: [] }, createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      TAIL_MESSAGE,
    ]);
  });

  test("今日の日付は末尾にだけ置く", () => {
    const input = buildInput({ summary: null, messages: [] }, createImageStub());

    expect(JSON.stringify(input.at(-1))).toContain("2026-10-21");
    expect(JSON.stringify(input.at(-1))).toContain("Wednesday");
    // 履歴の側には日付を混ぜない（プロンプトキャッシュの当たる先頭を変えない）。
    expect(JSON.stringify(input.slice(0, -1))).not.toContain("Today is");
  });

  test("履歴は保存された順にそのまま並ぶ", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "質問" });
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [{ type: "text", text: "回答", at: 1 }],
    });

    expect(buildInput(contextOf(store), createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "質問" },
      { role: "assistant", content: "回答" },
      TAIL_MESSAGE,
    ]);
  });

  test("添付ファイルの案内は、content と attachments から組み立てる", () => {
    const store = makeStore();
    store.appendMessage({
      id: "m1",
      teraId: DEFAULT_TERA_ID,
      role: "user",
      content: "見て",
      attachments: [{ name: "notes.txt", size: 5, path: "/home/agent/uploads/x/01-notes.txt" }],
    });

    const input = buildInput(contextOf(store), createImageStub());
    const user = input[1];
    if (user?.role !== "user" || typeof user.content !== "string") throw new Error("ユーザー発言が無い");

    expect(user.content.startsWith("見て\n\n[Attached files]\n")).toBe(true);
    expect(user.content).toContain("notes.txt: /home/agent/uploads/x/01-notes.txt (5 B)");
    expect(user.content).toContain("Open them with the read or bash tools.");
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

    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [{ type: "text", text: "最初の回答", at: 1 }],
    });
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
        { type: "text", text: "調べます。", at: 1 },
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
      TAIL_MESSAGE,
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

  test("添付と注記は、モデルへ戻さない", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "調べて" });
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [
        { type: "text", text: "調べます。", at: 1 },
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
          at: 2,
        },
        { type: "notice", text: "注記", at: 3 },
      ],
    });

    const input = buildInput(contextOf(store), createImageStub());
    // 本文とツールの呼び出しは戻り、添付と注記は戻らない。
    expect(input[2]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "調べます。" },
        { type: "tool-call", toolCallId: "call-1", toolName: "chat_attach", input: { files: ["x.png"] } },
      ],
    });
    expect(JSON.stringify(input)).not.toContain('"type":"attachment"');
    expect(JSON.stringify(input)).not.toContain("/api/images/x.png");
    expect(JSON.stringify(input)).not.toContain("注記");
  });

  test("添付だけのターンは、モデルへの履歴から省く", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "見て" });
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [
        {
          type: "attachment",
          attachments: [{ name: "x.png", size: 3, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
          at: 2,
        },
        { type: "notice", text: "注記", at: 3 },
      ],
    });
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "次" });

    const input = buildInput(contextOf(store), createImageStub());
    expect(input.some((message) => message.role === "assistant")).toBe(false);
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
  test("設定した言語の指示と今日の日付を、入力の末尾に 1 件だけ置く", () => {
    const ja = buildModelInput(
      { summary: null, messages: [] },
      createImageStub(),
      "ja",
      { toolResultImages: true },
      NOW,
    );
    const en = buildModelInput(
      { summary: null, messages: [] },
      createImageStub(),
      "en",
      { toolResultImages: true },
      NOW,
    );

    expect(ja.at(-1)).toEqual(TAIL_MESSAGE);
    expect(en.at(-1)).toEqual({ role: "user", content: turnTail("en", NOW) });
    expect(replyLanguageInstruction("ja")).toContain("Japanese");
    expect(replyLanguageInstruction("en")).toContain("English");
  });
});

describe("画像つきのツール結果", () => {
  /** 画面を撮ったことにして、画像つきの結果を 1 つ持つ履歴を作る。 */
  function screenshotHistory(result: { images?: ImageRef[] }) {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "画面を見て" });
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "見ます。",
      parts: [
        { type: "text", text: "見ます。", at: 1 },
        { type: "tool-call", id: "call-1", server: "computer", tool: "screenshot", args: {} },
        {
          type: "tool-result",
          id: "call-1",
          server: "computer",
          tool: "screenshot",
          failed: false,
          output: "The screen is 1280x800 pixels.",
          ...(result.images === undefined ? {} : { images: result.images }),
        },
      ],
    });
    return contextOf(store);
  }

  test("画像を置けるプロバイダには、ツール結果の content として渡す", () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-prompt-"));
    const images = createImageStore(dir);
    const png = testPng(1280, 800);

    try {
      const ref = images.save(png, "image/png");
      const input = buildModelInput(
        screenshotHistory({ images: [ref] }),
        images,
        "ja",
        { toolResultImages: true },
        NOW,
      );

      expect(input[3]).toEqual({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "computer_screenshot",
            output: {
              type: "content",
              value: [
                { type: "text", text: "The screen is 1280x800 pixels." },
                { type: "file", mediaType: "image/png", data: { type: "data", data: png } },
              ],
            },
          },
        ],
      });

      // 画像は結果の中にあるので、user メッセージは足さない。
      expect(input[4]).toEqual(TAIL_MESSAGE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("画像を置けないプロバイダには、結果の直後の user メッセージで渡す", () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-prompt-"));
    const images = createImageStore(dir);
    const png = testPng(1280, 800);

    try {
      const ref = images.save(png, "image/png");
      const input = buildModelInput(
        screenshotHistory({ images: [ref] }),
        images,
        "ja",
        { toolResultImages: false },
        NOW,
      );

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
          { type: "text", text: "(image from the computer_screenshot call)" },
          { type: "file", mediaType: "image/png", data: { type: "data", data: png } },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("複数の画像は、1 つの user メッセージにまとめる", () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-prompt-"));
    const images = createImageStore(dir);
    const first = testPng(10, 20);
    const second = testPng(30, 40);

    try {
      const refs = [images.save(first, "image/png"), images.save(second, "image/png")];
      const input = buildModelInput(
        screenshotHistory({ images: refs }),
        images,
        "ja",
        { toolResultImages: false },
        NOW,
      );

      expect(input[4]).toEqual({
        role: "user",
        content: [
          {
            type: "text",
            text: "(image from the computer_screenshot call)\n(image from the computer_screenshot call)",
          },
          { type: "file", mediaType: "image/png", data: { type: "data", data: first } },
          { type: "file", mediaType: "image/png", data: { type: "data", data: second } },
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

      expect(buildInput(screenshotHistory({ images: [second] }), images)).toEqual(
        buildInput(screenshotHistory({ images: [first] }), images),
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
      const input = buildInput(screenshotHistory({ images: [missing] }), images);
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
      // 読めない画像のために user メッセージは足さない。
      expect(input[4]).toEqual(TAIL_MESSAGE);
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
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [{ type: "text", text: "承知しました", at: 1 }],
    });
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
      TAIL_MESSAGE,
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

    store.appendMessage({
      id: "m4",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "",
      parts: [{ type: "text", text: "回答", at: 1 }],
    });
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

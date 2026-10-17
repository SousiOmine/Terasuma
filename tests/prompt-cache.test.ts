import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageStore } from "../src/server/images";
import { buildModelInput, observationsText, SYSTEM_PROMPT, type TeraContext } from "../src/server/prompt";
import { DEFAULT_TERA_ID } from "../src/server/store";
import type { ImageRef } from "../src/shared/types";
import { createImageStub, createMemoryStub, makeStore, testPng } from "./support";

/**
 * モデルへ渡る文脈。記憶はストアに置かれたものをそのまま使う（本番と同じ組み立てを通す）。
 */
function contextOf(store: ReturnType<typeof makeStore>): TeraContext {
  return createMemoryStub(store).context(DEFAULT_TERA_ID);
}

/**
 * プロンプトキャッシュは、リクエストの先頭が前回と一致するほど当たる。
 * ここが変わると気づかないうちにコストが増えるだけで分かりにくいため、テストで常に確認する。
 * 先頭は「system プロンプト → 観察の記録」、そのうしろに生の履歴が続く。
 */
describe("プロンプトキャッシュ保護", () => {
  test("入力の先頭は常に system プロンプト 1 件", () => {
    expect(buildModelInput({ observations: null, messages: [] }, createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
    ]);
  });

  test("履歴は保存された順にそのまま並ぶ", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "質問" });
    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "回答" });

    expect(buildModelInput(contextOf(store), createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "質問" },
      { role: "assistant", content: "回答" },
    ]);
  });

  test("同じ履歴からは常に同じ入力が組み立てられる", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "質問" });

    // 日時や件数などを混ぜると、ここで差分が出てテストが失敗する。
    expect(buildModelInput(contextOf(store), createImageStub())).toEqual(buildModelInput(contextOf(store), createImageStub()));
  });

  test("次のターンの入力は、前のターンの入力で始まる", () => {
    const store = makeStore();

    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "最初の質問" });
    const turn1 = buildModelInput(contextOf(store), createImageStub());

    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "最初の回答" });
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "次の質問" });
    const turn2 = buildModelInput(contextOf(store), createImageStub());

    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    // シリアライズしたバイト列としても接頭辞になっていること（実際のキャッシュ条件）。
    expect(JSON.stringify(turn2).startsWith(JSON.stringify(turn1).slice(0, -1))).toBe(true);
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

    expect(buildModelInput(contextOf(store), createImageStub())).toEqual([
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

    const input = buildModelInput(contextOf(store), createImageStub());
    expect(input[3]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "local_echo",
          output: { type: "error-text", value: "この呼び出しは中断されたため、結果がありません" },
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

    const input = buildModelInput(contextOf(store), createImageStub());
    expect(input.at(-1)).toEqual({
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
    const turn1 = buildModelInput(contextOf(store), createImageStub());

    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "次の質問" });
    const turn2 = buildModelInput(contextOf(store), createImageStub());

    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    expect(JSON.stringify(turn2).startsWith(JSON.stringify(turn1).slice(0, -1))).toBe(true);
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
      const input = buildModelInput(screenshotHistory({ image: ref }), images);

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

      expect(buildModelInput(screenshotHistory({ image: second }), images)).toEqual(
        buildModelInput(screenshotHistory({ image: first }), images),
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
      const input = buildModelInput(screenshotHistory({ image: missing }), images);
      expect(input[3]).toEqual({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "computer_screenshot",
            output: {
              type: "text",
              value: "The screen is 1280x800 pixels.\n(保存した画像を読み出せませんでした)",
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
 * 記憶を渡すときの並び。観察の記録は system プロンプトの直後に 1 件だけ置き、
 * そこから先は生の履歴が続く（記録は末尾に足されていくので、前置きは育つだけで変わらない）。
 */
describe("観察の記録を渡すとき", () => {
  /** 観察の記録を 1 つ持ち、そこまでの履歴を畳んだストア。 */
  function storeWithObservations(text: string, throughSeq: number): ReturnType<typeof makeStore> {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "京都に住んでいます" });
    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "承知しました" });
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "次の質問" });
    store.writeObservations(DEFAULT_TERA_ID, { text, throughSeq });
    return store;
  }

  const LOG = "Date: 2026-10-16\n* 🔴 (09:00) 京都に住んでいる。";

  test("観察の記録は、system プロンプトの直後に 1 件だけ置く", () => {
    expect(buildModelInput(contextOf(storeWithObservations(LOG, 2)), createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: observationsText(LOG) },
      { role: "user", content: "次の質問" },
    ]);
  });

  test("観察済みのメッセージは、生の履歴には残らない", () => {
    const input = buildModelInput(contextOf(storeWithObservations(LOG, 2)), createImageStub());
    expect(input.some((message) => JSON.stringify(message).includes("京都に住んでいます"))).toBe(false);

    // まだ観察していない分は生のまま残る。
    const pending = buildModelInput(contextOf(storeWithObservations(LOG, 0)), createImageStub());
    expect(pending.some((message) => JSON.stringify(message).includes("京都に住んでいます"))).toBe(true);
  });

  test("記録が変わらなければ、次のターンの入力は前のターンで始まる", () => {
    const store = storeWithObservations(LOG, 2);
    const turn1 = buildModelInput(contextOf(store), createImageStub());

    store.appendMessage({ id: "m4", teraId: DEFAULT_TERA_ID, role: "assistant", content: "回答" });
    store.appendMessage({ id: "m5", teraId: DEFAULT_TERA_ID, role: "user", content: "さらに質問" });
    const turn2 = buildModelInput(contextOf(store), createImageStub());

    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    expect(JSON.stringify(turn2).startsWith(JSON.stringify(turn1).slice(0, -1))).toBe(true);
  });

  test("記録が育っても、前置きは前のターンと頭から一致する", () => {
    const before = observationsText(LOG);
    const after = observationsText(`${LOG}\n* 🟡 (10:00) 画面を確認した。`);

    // 記録は末尾に足されるだけなので、前の記録の終わりまでは同じ文字列になる。
    expect(after.startsWith(before.slice(0, before.indexOf(LOG) + LOG.length))).toBe(true);
  });
});

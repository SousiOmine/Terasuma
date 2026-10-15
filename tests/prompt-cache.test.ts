import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageStore } from "../src/server/images";
import { buildModelInput, SYSTEM_PROMPT } from "../src/server/prompt";
import type { ImageRef } from "../src/shared/types";
import { createImageStub, makeStore, testPng } from "./support";

/**
 * プロンプトキャッシュは、リクエストの先頭が前回と一致するほど当たる。
 * ここが変わると気づかないうちにコストが増えるだけで分かりにくいため、テストで常に確認する。
 */
describe("プロンプトキャッシュ保護", () => {
  test("入力の先頭は常に system プロンプト 1 件", () => {
    expect(buildModelInput([], createImageStub())).toEqual([{ role: "system", content: SYSTEM_PROMPT }]);
  });

  test("履歴は保存された順にそのまま並ぶ", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "質問" });
    store.appendMessage({ id: "m2", sessionId: "s1", role: "assistant", content: "回答" });

    expect(buildModelInput(store.listMessages("s1"), createImageStub())).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "質問" },
      { role: "assistant", content: "回答" },
    ]);
  });

  test("同じ履歴からは常に同じ入力が組み立てられる", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "質問" });

    // 日時や件数などを混ぜると、ここで差分が出てテストが失敗する。
    expect(buildModelInput(store.listMessages("s1"), createImageStub())).toEqual(buildModelInput(store.listMessages("s1"), createImageStub()));
  });

  test("次のターンの入力は、前のターンの入力で始まる", () => {
    const store = makeStore();
    store.ensureSession("s1", null);

    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "最初の質問" });
    const turn1 = buildModelInput(store.listMessages("s1"), createImageStub());

    store.appendMessage({ id: "m2", sessionId: "s1", role: "assistant", content: "最初の回答" });
    store.appendMessage({ id: "m3", sessionId: "s1", role: "user", content: "次の質問" });
    const turn2 = buildModelInput(store.listMessages("s1"), createImageStub());

    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    // シリアライズしたバイト列としても接頭辞になっていること（実際のキャッシュ条件）。
    expect(JSON.stringify(turn2).startsWith(JSON.stringify(turn1).slice(0, -1))).toBe(true);
  });
});

describe("ツールを使ったターンの入力", () => {
  /** ツールを 1 回使った 1 ターン分の履歴。 */
  function toolHistory(store: ReturnType<typeof makeStore>) {
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "調べて" });
    store.appendMessage({
      id: "m2",
      sessionId: "s1",
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

    expect(buildModelInput(store.listMessages("s1"), createImageStub())).toEqual([
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
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "調べて" });
    store.appendMessage({
      id: "m2",
      sessionId: "s1",
      role: "assistant",
      content: "",
      parts: [{ type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } }],
    });

    const input = buildModelInput(store.listMessages("s1"), createImageStub());
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
    store.appendMessage({ id: "m3", sessionId: "s1", role: "user", content: "もう一度" });
    store.appendMessage({
      id: "m4",
      sessionId: "s1",
      role: "assistant",
      content: "",
      parts: [
        { type: "tool-call", id: "call-2", server: "local", tool: "fail", args: { reason: "test" } },
        { type: "tool-result", id: "call-2", server: "local", tool: "fail", failed: true, output: "失敗: test" },
      ],
    });

    const input = buildModelInput(store.listMessages("s1"), createImageStub());
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
    const turn1 = buildModelInput(store.listMessages("s1"), createImageStub());

    store.appendMessage({ id: "m3", sessionId: "s1", role: "user", content: "次の質問" });
    const turn2 = buildModelInput(store.listMessages("s1"), createImageStub());

    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    expect(JSON.stringify(turn2).startsWith(JSON.stringify(turn1).slice(0, -1))).toBe(true);
  });
});

describe("画像つきのツール結果", () => {
  /** 画面を撮ったことにして、画像つきの結果を 1 つ持つ履歴を作る。 */
  function screenshotHistory(result: { image?: ImageRef }) {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "画面を見て" });
    store.appendMessage({
      id: "m2",
      sessionId: "s1",
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
    return store.listMessages("s1");
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

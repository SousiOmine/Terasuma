import { describe, expect, test } from "bun:test";
import { buildModelInput, SYSTEM_PROMPT } from "../src/server/prompt";
import { makeStore } from "./support";

/**
 * プロンプトキャッシュは、リクエストの先頭が前回と一致するほど当たる。
 * ここが変わると気づかないうちにコストが増えるだけで分かりにくいため、テストで常に確認する。
 */
describe("プロンプトキャッシュ保護", () => {
  test("入力の先頭は常に system プロンプト 1 件", () => {
    expect(buildModelInput([])).toEqual([{ role: "system", content: SYSTEM_PROMPT }]);
  });

  test("履歴は保存された順にそのまま並ぶ", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "質問" });
    store.appendMessage({ id: "m2", sessionId: "s1", role: "assistant", content: "回答" });

    expect(buildModelInput(store.listMessages("s1"))).toEqual([
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
    expect(buildModelInput(store.listMessages("s1"))).toEqual(buildModelInput(store.listMessages("s1")));
  });

  test("次のターンの入力は、前のターンの入力で始まる", () => {
    const store = makeStore();
    store.ensureSession("s1", null);

    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "最初の質問" });
    const turn1 = buildModelInput(store.listMessages("s1"));

    store.appendMessage({ id: "m2", sessionId: "s1", role: "assistant", content: "最初の回答" });
    store.appendMessage({ id: "m3", sessionId: "s1", role: "user", content: "次の質問" });
    const turn2 = buildModelInput(store.listMessages("s1"));

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

    expect(buildModelInput(store.listMessages("s1"))).toEqual([
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

    const input = buildModelInput(store.listMessages("s1"));
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

    const input = buildModelInput(store.listMessages("s1"));
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
    const turn1 = buildModelInput(store.listMessages("s1"));

    store.appendMessage({ id: "m3", sessionId: "s1", role: "user", content: "次の質問" });
    const turn2 = buildModelInput(store.listMessages("s1"));

    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    expect(JSON.stringify(turn2).startsWith(JSON.stringify(turn1).slice(0, -1))).toBe(true);
  });
});

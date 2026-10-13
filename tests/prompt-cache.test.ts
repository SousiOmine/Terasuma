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

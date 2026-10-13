import { describe, expect, test } from "bun:test";
import { deriveTitle, TITLE_MAX_LENGTH } from "../src/server/store";
import { makeStore } from "./support";

describe("deriveTitle", () => {
  test("空文字と空白だけの入力は null", () => {
    expect(deriveTitle("")).toBeNull();
    expect(deriveTitle("   \n  \n")).toBeNull();
  });

  test("最初の空でない行を使う", () => {
    expect(deriveTitle("\n  こんにちは  \n続き")).toBe("こんにちは");
  });

  test("長すぎる場合は切り詰める", () => {
    const title = deriveTitle("あ".repeat(TITLE_MAX_LENGTH + 10));
    expect(title).toBe(`${"あ".repeat(TITLE_MAX_LENGTH)}…`);
  });
});

describe("store", () => {
  test("ensureSession は最初の発言からタイトルを作り、以後は上書きしない", () => {
    const store = makeStore();

    const created = store.ensureSession("s1", "最初のメッセージ");
    expect(created.title).toBe("最初のメッセージ");

    const again = store.ensureSession("s1", "二番目のメッセージ");
    expect(again.title).toBe("最初のメッセージ");
    expect(again.createdAt).toBe(created.createdAt);
  });

  test("appendMessage は連番を振り、セッションの更新時刻を進める", () => {
    const store = makeStore();
    const session = store.ensureSession("s1", null);
    expect(session.title).toBeNull();

    const first = store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "こんにちは" });
    const second = store.appendMessage({ id: "m2", sessionId: "s1", role: "assistant", content: "やあ" });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(store.getSession("s1")?.title).toBe("こんにちは");
    expect(store.getSession("s1")?.updatedAt).toBeGreaterThan(session.createdAt);
  });

  test("assistant の発言からはタイトルを作らない", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "assistant", content: "先に喋る" });

    expect(store.getSession("s1")?.title).toBeNull();
  });

  test("listMessages は seq 昇順で返す", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "1" });
    store.appendMessage({ id: "m2", sessionId: "s1", role: "assistant", content: "2" });
    store.appendMessage({ id: "m3", sessionId: "s1", role: "user", content: "3" });

    expect(store.listMessages("s1").map((message) => message.content)).toEqual(["1", "2", "3"]);
    expect(store.listMessages("s1").map((message) => message.seq)).toEqual([1, 2, 3]);
  });

  test("usage を保存して読み戻せる", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      content: "本文",
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 5 },
    });

    expect(store.listMessages("s1")[0]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 5,
    });
  });

  test("usage が無ければ null", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "本文" });

    expect(store.listMessages("s1")[0]?.usage).toBeNull();
  });

  test("renameSession は前後の空白を取り除き、空文字は拒否する", () => {
    const store = makeStore();
    store.ensureSession("s1", null);

    expect(store.renameSession("s1", "  新しい名前  ")).toBe(true);
    expect(store.getSession("s1")?.title).toBe("新しい名前");

    expect(store.renameSession("s1", "   ")).toBe(false);
    expect(store.getSession("s1")?.title).toBe("新しい名前");
  });

  test("存在しないセッションの操作は失敗を返す", () => {
    const store = makeStore();

    expect(store.getSession("missing")).toBeNull();
    expect(store.renameSession("missing", "名前")).toBe(false);
    expect(store.deleteSession("missing")).toBe(false);
  });

  test("deleteSession はメッセージも一緒に消す", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "本文" });

    expect(store.deleteSession("s1")).toBe(true);
    expect(store.getSession("s1")).toBeNull();
    expect(store.listMessages("s1")).toEqual([]);
  });

  test("listSessions は更新の新しい順に並ぶ", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.ensureSession("s2", null);
    // s2 の方が後に作られ、その後 s1 を更新する。
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "あとから" });

    expect(store.listSessions().map((session) => session.id)).toEqual(["s1", "s2"]);
  });
});

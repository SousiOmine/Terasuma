import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, deriveTitle, TITLE_MAX_LENGTH } from "../src/server/store";
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

  test("ツールの部分を保存して、並びのまま読み戻せる", () => {
    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "調べて" });
    store.appendMessage({
      id: "m2",
      sessionId: "s1",
      role: "assistant",
      content: "調べます。分かりました。",
      parts: [
        { type: "text", text: "調べます。" },
        { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
        { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
        { type: "text", text: "分かりました。" },
      ],
    });

    const [user, assistant] = store.listMessages("s1");
    expect(user?.parts).toBeNull();
    expect(assistant?.parts).toEqual([
      { type: "text", text: "調べます。" },
      { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
      { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
      { type: "text", text: "分かりました。" },
    ]);
  });

  test("ツールを持たなかった頃の DB を開くと、parts 列を足して読める", () => {
    const path = join(tmpdir(), `terasuma-store-${crypto.randomUUID()}.db`);

    try {
      // parts 列が無い、前の版のスキーマ。
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, created_at INTEGER NOT NULL,
          input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
          UNIQUE (session_id, seq)
        );
      `);
      legacy.run("INSERT INTO sessions VALUES ('s1', '古い会話', 1, 2)");
      legacy.run("INSERT INTO messages (id, session_id, seq, role, content, created_at) VALUES ('m1', 's1', 1, 'assistant', '古い本文', 3)");
      legacy.close();

      const store = createStore(path);
      try {
        const messages = store.listMessages("s1");
        expect(messages[0]?.content).toBe("古い本文");
        expect(messages[0]?.parts).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("usage が無ければ null", () => {    const store = makeStore();
    store.ensureSession("s1", null);
    store.appendMessage({ id: "m1", sessionId: "s1", role: "user", content: "本文" });

    expect(store.listMessages("s1")[0]?.usage).toBeNull();
  });

  test("存在しないセッションの操作は失敗を返す", () => {
    const store = makeStore();

    expect(store.getSession("missing")).toBeNull();
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

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, DEFAULT_TERA_ID } from "../src/server/store";
import { makeStore } from "./support";

/** 一時ファイルの DB を片付ける。WAL と共有メモリのファイルも残さない。 */
function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

describe("store", () => {
  test("起動すると、既定の Tera が 1 体だけ用意される", () => {
    const store = makeStore();

    const teras = store.listTeras();
    expect(teras).toHaveLength(1);
    expect(teras[0]?.id).toBe(DEFAULT_TERA_ID);
    expect(teras[0]?.name).toBe("Tera");
  });

  test("ensureTera は無ければ作り、既にあれば名前も作成日時も変えない", () => {
    const store = makeStore();

    const created = store.ensureTera("second", "2 体目");
    expect(created.name).toBe("2 体目");

    const again = store.ensureTera("second", "別の名前");
    expect(again.name).toBe("2 体目");
    expect(again.createdAt).toBe(created.createdAt);
  });

  test("appendMessage は連番を振り、Tera の更新時刻を進める", () => {
    const store = makeStore();
    const before = store.getTera(DEFAULT_TERA_ID);
    if (before === null) throw new Error("既定の Tera が無い");

    const first = store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "こんにちは" });
    const second = store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "やあ" });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(store.getTera(DEFAULT_TERA_ID)?.updatedAt).toBeGreaterThan(before.createdAt);
  });

  test("listMessages は seq 昇順で返す", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "1" });
    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "2" });
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "3" });

    expect(store.listMessages(DEFAULT_TERA_ID).map((message) => message.content)).toEqual(["1", "2", "3"]);
    expect(store.listMessages(DEFAULT_TERA_ID).map((message) => message.seq)).toEqual([1, 2, 3]);
  });

  test("usage を保存して読み戻せる", () => {
    const store = makeStore();
    store.appendMessage({
      id: "m1",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "本文",
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 5 },
    });

    expect(store.listMessages(DEFAULT_TERA_ID)[0]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 5,
    });
  });

  test("ツールの部分を保存して、並びのまま読み戻せる", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "調べて" });
    store.appendMessage({
      id: "m2",
      teraId: DEFAULT_TERA_ID,
      role: "assistant",
      content: "調べます。分かりました。",
      parts: [
        { type: "text", text: "調べます。" },
        { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
        { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
        { type: "text", text: "分かりました。" },
      ],
    });

    const [user, assistant] = store.listMessages(DEFAULT_TERA_ID);
    expect(user?.parts).toBeNull();
    expect(assistant?.parts).toEqual([
      { type: "text", text: "調べます。" },
      { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
      { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
      { type: "text", text: "分かりました。" },
    ]);
  });

  test("usage が無ければ null", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "本文" });

    expect(store.listMessages(DEFAULT_TERA_ID)[0]?.usage).toBeNull();
  });

  test("存在しない Tera は null", () => {
    const store = makeStore();

    expect(store.getTera("missing")).toBeNull();
  });

  test("履歴は Tera ごとに分かれる", () => {
    const store = makeStore();
    store.ensureTera("second", "2 体目");

    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "既定へ" });
    store.appendMessage({ id: "m2", teraId: "second", role: "user", content: "2 体目へ" });

    expect(store.listMessages(DEFAULT_TERA_ID).map((message) => message.content)).toEqual(["既定へ"]);
    expect(store.listMessages("second").map((message) => message.content)).toEqual(["2 体目へ"]);
  });

  test("listTeras は更新の新しい順に並ぶ", () => {
    const store = makeStore();
    store.ensureTera("second", "2 体目");
    // second を作ったあとに既定へ追記するので、既定の方が新しくなる。
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "あとから" });

    expect(store.listTeras().map((tera) => tera.id)).toEqual([DEFAULT_TERA_ID, "second"]);
  });

  test("開き直しても、既定の Tera と履歴はそのまま", () => {
    const path = join(tmpdir(), `terasuma-store-${crypto.randomUUID()}.db`);

    try {
      const first = createStore(path);
      const created = first.getTera(DEFAULT_TERA_ID);
      first.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "残る本文" });
      first.close();

      const second = createStore(path);
      try {
        const again = second.getTera(DEFAULT_TERA_ID);
        expect(again?.name).toBe("Tera");
        expect(again?.createdAt).toBe(created?.createdAt);
        expect(second.listMessages(DEFAULT_TERA_ID).map((message) => message.content)).toEqual(["残る本文"]);
      } finally {
        second.close();
      }
    } finally {
      removeDatabase(path);
    }
  });

  test("セッションごとに会話を分けていた頃の DB は、Tera の形に作り替える", () => {
    const path = join(tmpdir(), `terasuma-store-${crypto.randomUUID()}.db`);

    try {
      // 前の版のスキーマ。会話はセッションに属し、parts 列を持っていた。
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, parts TEXT, created_at INTEGER NOT NULL,
          input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
          UNIQUE (session_id, seq)
        );
      `);
      legacy.run("INSERT INTO sessions VALUES ('s1', '古い会話', 1, 2)");
      legacy.run(
        "INSERT INTO messages (id, session_id, seq, role, content, created_at) VALUES ('m1', 's1', 1, 'user', '古い本文', 3)",
      );
      legacy.close();

      const store = createStore(path);
      try {
        // 会話の持ち主が変わるので、古い会話は引き継がない。
        expect(store.listTeras().map((tera) => tera.id)).toEqual([DEFAULT_TERA_ID]);
        expect(store.listMessages(DEFAULT_TERA_ID)).toEqual([]);

        // 作り替えたあとは、これまでどおり書き込める（連番も 1 から）。
        const appended = store.appendMessage({
          id: "m2",
          teraId: DEFAULT_TERA_ID,
          role: "user",
          content: "新しい本文",
        });
        expect(appended.seq).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      removeDatabase(path);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, DEFAULT_TERA_ID, DEFAULT_TERA_IDENTITY, type Store } from "../src/server/data/store";
import type { ChatMessage } from "../src/shared/api/message";
import { makeStore } from "./support";

/** 一時ファイルの DB を片付ける。WAL と共有メモリのファイルも残さない。 */
function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

/** ページをたどって、その Tera の履歴を全部読む。 */
function allMessages(store: Store, teraId: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let before: number | null = null;

  for (;;) {
    const page = store.listMessagesPage(teraId, { limit: 100, before });
    messages.unshift(...page.messages);
    if (!page.hasMore) return messages;

    const oldest = page.messages[0];
    if (oldest === undefined) throw new Error("hasMore なのにメッセージが空です");
    before = oldest.seq;
  }
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

  test("新しい Tera には、既定の役割が system プロンプト用として入っている", () => {
    const store = makeStore();
    const identity = store.readIdentity(DEFAULT_TERA_ID);

    expect(identity.content).toBe(DEFAULT_TERA_IDENTITY);
    expect(identity.applied).toBe(DEFAULT_TERA_IDENTITY);
  });

  test("identity を書いても、system プロンプト用の版は変わらない", () => {
    const store = makeStore();
    const written = store.writeIdentity(DEFAULT_TERA_ID, "# Role\n調べる");

    expect(written).toEqual({ content: "# Role\n調べる", applied: DEFAULT_TERA_IDENTITY });
    expect(store.readIdentity(DEFAULT_TERA_ID)).toEqual(written);
  });

  test("identity を切り替えると、書いた版が system プロンプト用になる", () => {
    const store = makeStore();
    store.writeIdentity(DEFAULT_TERA_ID, "# Role\n調べる");

    expect(store.applyIdentity(DEFAULT_TERA_ID)).toBe(true);
    expect(store.readIdentity(DEFAULT_TERA_ID)).toEqual({
      content: "# Role\n調べる",
      applied: "# Role\n調べる",
    });
  });

  test("同じ内容で identity を切り替えても、変化なしとして扱う", () => {
    const store = makeStore();

    expect(store.applyIdentity(DEFAULT_TERA_ID)).toBe(false);
  });

  test("identity は Tera ごとに別", () => {
    const store = makeStore();
    store.ensureTera("second", "2 体目");
    store.writeIdentity("second", "# Role\n2 体目");

    expect(store.readIdentity("second").content).toBe("# Role\n2 体目");
    expect(store.readIdentity(DEFAULT_TERA_ID).content).toBe(DEFAULT_TERA_IDENTITY);
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

  test("画面の本文と添付を保存する", () => {
    const store = makeStore();
    const attachment = {
      name: "notes.txt",
      size: 5,
      path: "/home/agent/uploads/x/01-notes.txt",
    };
    const message = store.appendMessage({
      id: "m1",
      teraId: DEFAULT_TERA_ID,
      role: "user",
      content: "画面に出す本文",
      attachments: [attachment],
    });

    expect(message.content).toBe("画面に出す本文");
    expect(message.attachments).toEqual([attachment]);

    const [saved] = allMessages(store, DEFAULT_TERA_ID);
    expect(saved).toEqual(message);
  });

  test("listMessagesPage でページをたどると seq 昇順で返す", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "1" });
    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "assistant", content: "2" });
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "3" });

    expect(allMessages(store, DEFAULT_TERA_ID).map((message) => message.content)).toEqual(["1", "2", "3"]);
    expect(allMessages(store, DEFAULT_TERA_ID).map((message) => message.seq)).toEqual([1, 2, 3]);
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

    expect(allMessages(store, DEFAULT_TERA_ID)[0]?.usage).toEqual({
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
        { type: "text", text: "調べます。", at: 1 },
        { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
        { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
        { type: "text", text: "分かりました。", at: 1 },
      ],
    });

    const [user, assistant] = allMessages(store, DEFAULT_TERA_ID);
    expect(user?.parts).toBeNull();
    expect(assistant?.parts).toEqual([
      { type: "text", text: "調べます。", at: 1 },
      { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
      { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
      { type: "text", text: "分かりました。", at: 1 },
    ]);
  });

  test("usage が無ければ null", () => {
    const store = makeStore();
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "本文" });

    expect(allMessages(store, DEFAULT_TERA_ID)[0]?.usage).toBeNull();
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

    expect(allMessages(store, DEFAULT_TERA_ID).map((message) => message.content)).toEqual(["既定へ"]);
    expect(allMessages(store, "second").map((message) => message.content)).toEqual(["2 体目へ"]);
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
        expect(allMessages(second, DEFAULT_TERA_ID).map((message) => message.content)).toEqual(["残る本文"]);
      } finally {
        second.close();
      }
    } finally {
      removeDatabase(path);
    }
  });

  test("開き直しても、identity は書いた版と切り替えた版のまま", () => {
    const path = join(tmpdir(), `terasuma-store-${crypto.randomUUID()}.db`);

    try {
      const first = createStore(path);
      first.writeIdentity(DEFAULT_TERA_ID, "# Role\n残る役割");
      first.applyIdentity(DEFAULT_TERA_ID);
      first.close();

      const second = createStore(path);
      try {
        expect(second.readIdentity(DEFAULT_TERA_ID)).toEqual({
          content: "# Role\n残る役割",
          applied: "# Role\n残る役割",
        });
      } finally {
        second.close();
      }
    } finally {
      removeDatabase(path);
    }
  });

  test("v1 の DB は、添付の列を足してそのまま読める", () => {
    const path = join(tmpdir(), `terasuma-store-${crypto.randomUUID()}.db`);

    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE teras (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, tera_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, parts TEXT, created_at INTEGER NOT NULL,
          input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
          UNIQUE (tera_id, seq)
        );
        PRAGMA user_version = 1;
      `);
      legacy.run("INSERT INTO teras VALUES ('default', 'Tera', 1, 2)");
      legacy.run(
        "INSERT INTO messages (id, tera_id, seq, role, content, created_at) VALUES ('m1', 'default', 1, 'user', '古い本文', 3)",
      );
      legacy.close();

      const store = createStore(path);
      try {
        const [message] = allMessages(store, DEFAULT_TERA_ID);
        expect(message?.content).toBe("古い本文");
        expect(message?.attachments).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      removeDatabase(path);
    }
  });

  test("v2 の DB は、assistant の本文を text パーツへ移して読める", () => {
    const path = join(tmpdir(), `terasuma-store-${crypto.randomUUID()}.db`);

    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE teras (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, tera_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, attachments TEXT, parts TEXT, created_at INTEGER NOT NULL,
          input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
          UNIQUE (tera_id, seq)
        );
        PRAGMA user_version = 2;
      `);
      legacy.run("INSERT INTO teras VALUES ('default', 'Tera', 1, 2)");
      legacy.run(
        "INSERT INTO messages (id, tera_id, seq, role, content, created_at) VALUES ('m1', 'default', 1, 'user', '質問', 2)",
      );
      legacy.run(
        "INSERT INTO messages (id, tera_id, seq, role, content, created_at) VALUES ('m2', 'default', 2, 'assistant', '古い返事', 3)",
      );
      legacy.run(
        "INSERT INTO messages (id, tera_id, seq, role, content, parts, created_at) VALUES ('m3', 'default', 3, 'assistant', '調べます。分かりました。', ?, 4)",
        [
          JSON.stringify([
            { type: "text", text: "調べます。" },
            { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
            { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
            { type: "text", text: "分かりました。" },
          ]),
        ],
      );
      legacy.close();

      const store = createStore(path);
      try {
        const [user, plain, tool] = allMessages(store, DEFAULT_TERA_ID);

        // ユーザーの発言はそのまま。
        expect(user?.content).toBe("質問");
        expect(user?.parts).toBeNull();

        // 本文しか無かった返事は、画面に出す text 1 件になる。
        expect(plain?.content).toBe("");
        expect(plain?.parts).toEqual([{ type: "text", text: "古い返事", at: 3 }]);

        // ツールを使った返事は、本文の位置ごとに text が並ぶ。
        expect(tool?.content).toBe("");
        expect(tool?.parts).toEqual([
          { type: "text", text: "調べます。", at: 4 },
          { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
          { type: "tool-result", id: "call-1", server: "local", tool: "echo", failed: false, output: "echo: hi" },
          { type: "text", text: "分かりました。", at: 4 },
        ]);
      } finally {
        store.close();
      }
    } finally {
      removeDatabase(path);
    }
  });

  test("v3 の DB は、sent を text と attachment に分け、chat_send の記録を落とす", () => {
    const path = join(tmpdir(), `terasuma-store-${crypto.randomUUID()}.db`);

    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE teras (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, tera_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, attachments TEXT, parts TEXT, created_at INTEGER NOT NULL,
          input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
          UNIQUE (tera_id, seq)
        );
        PRAGMA user_version = 3;
      `);
      legacy.run("INSERT INTO teras VALUES ('default', 'Tera', 1, 2)");
      legacy.run(
        "INSERT INTO messages (id, tera_id, seq, role, content, parts, created_at) VALUES ('m1', 'default', 1, 'assistant', '', ?, 3)",
        [
          JSON.stringify([
            { type: "text", text: "調べます。" },
            { type: "tool-call", id: "call-1", server: "chat", tool: "send", args: { text: "調べます。" } },
            { type: "sent", text: "調べます。", attachments: [], at: 3 },
            {
              type: "tool-result",
              id: "call-1",
              server: "chat",
              tool: "send",
              failed: false,
              output: "Sent the message to the user.",
            },
            { type: "text", text: "分かりました。" },
            {
              type: "sent",
              text: "分かりました。",
              attachments: [{ name: "x.png", size: 3, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
              at: 4,
            },
          ]),
        ],
      );
      legacy.close();

      const store = createStore(path);
      try {
        const [assistant] = allMessages(store, DEFAULT_TERA_ID);
        expect(assistant?.content).toBe("");
        expect(assistant?.parts).toEqual([
          { type: "text", text: "調べます。", at: 3 },
          { type: "text", text: "分かりました。", at: 3 },
          {
            type: "attachment",
            attachments: [{ name: "x.png", size: 3, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
            at: 4,
          },
        ]);
      } finally {
        store.close();
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
        expect(allMessages(store, DEFAULT_TERA_ID)).toEqual([]);

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

describe("listMessagesPage", () => {
  function seed(store: Store): void {
    for (let index = 1; index <= 5; index += 1) {
      store.appendMessage({ id: `m${index}`, teraId: DEFAULT_TERA_ID, role: "user", content: String(index) });
    }
  }

  test("最新のページを古い順で返し、古い側の有無を返す", () => {
    const store = makeStore();
    seed(store);

    const page = store.listMessagesPage(DEFAULT_TERA_ID, { limit: 2, before: null });
    expect(page.messages.map((message) => message.content)).toEqual(["4", "5"]);
    expect(page.hasMore).toBe(true);
  });

  test("before で、その seq より前のページを読める", () => {
    const store = makeStore();
    seed(store);

    const page = store.listMessagesPage(DEFAULT_TERA_ID, { limit: 2, before: 4 });
    expect(page.messages.map((message) => message.content)).toEqual(["2", "3"]);
    expect(page.hasMore).toBe(true);

    const oldest = store.listMessagesPage(DEFAULT_TERA_ID, { limit: 2, before: 2 });
    expect(oldest.messages.map((message) => message.content)).toEqual(["1"]);
    expect(oldest.hasMore).toBe(false);

    const after = store.listMessagesPage(DEFAULT_TERA_ID, { limit: 2, before: 1 });
    expect(after.messages).toEqual([]);
    expect(after.hasMore).toBe(false);
  });

  test("limit が履歴より多ければ、全件を返して hasMore は false", () => {
    const store = makeStore();
    seed(store);

    const page = store.listMessagesPage(DEFAULT_TERA_ID, { limit: 10, before: null });
    expect(page.messages.map((message) => message.content)).toEqual(["1", "2", "3", "4", "5"]);
    expect(page.hasMore).toBe(false);
  });

  test("履歴が無ければ、空で hasMore は false", () => {
    const store = makeStore();

    expect(store.listMessagesPage(DEFAULT_TERA_ID, { limit: 20, before: null })).toEqual({
      messages: [],
      hasMore: false,
    });
  });

  test("別の Tera のメッセージは混ざらない", () => {
    const store = makeStore();
    store.ensureTera("second", "2 体目");
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "既定" });
    store.appendMessage({ id: "m2", teraId: "second", role: "user", content: "2 体目" });

    const page = store.listMessagesPage("second", { limit: 20, before: null });
    expect(page.messages.map((message) => message.content)).toEqual(["2 体目"]);
    expect(page.hasMore).toBe(false);
  });
});

describe("過去のやり取りの要約", () => {
  test("まだ畳んでいなければ、要約は空で、すべてが畳んでいない", () => {
    const store = makeStore();
    expect(store.readCompaction(DEFAULT_TERA_ID)).toEqual({
      summary: "",
      throughSeq: 0,
      tokensBefore: 0,
      createdAt: 0,
    });
  });

  test("書いた要約は読み直せて、上書きもできる", () => {
    const store = makeStore();
    store.writeCompaction(DEFAULT_TERA_ID, {
      summary: "## Goal\n京都に住んでいる。",
      throughSeq: 2,
      tokensBefore: 5_000,
      createdAt: 100,
    });
    expect(store.readCompaction(DEFAULT_TERA_ID)).toEqual({
      summary: "## Goal\n京都に住んでいる。",
      throughSeq: 2,
      tokensBefore: 5_000,
      createdAt: 100,
    });

    store.writeCompaction(DEFAULT_TERA_ID, {
      summary: "## Goal\n書き直した要約。",
      throughSeq: 4,
      tokensBefore: 9_000,
      createdAt: 200,
    });
    expect(store.readCompaction(DEFAULT_TERA_ID)).toEqual({
      summary: "## Goal\n書き直した要約。",
      throughSeq: 4,
      tokensBefore: 9_000,
      createdAt: 200,
    });
  });

  test("listMessagesSince は、その seq より後のメッセージだけを返す", () => {
    const store = makeStore();
    for (const seq of [1, 2, 3]) {
      store.appendMessage({ id: `m${seq}`, teraId: DEFAULT_TERA_ID, role: "user", content: `${seq}` });
    }

    expect(store.listMessagesSince(DEFAULT_TERA_ID, 0).map((message) => message.content)).toEqual(["1", "2", "3"]);
    expect(store.listMessagesSince(DEFAULT_TERA_ID, 2).map((message) => message.content)).toEqual(["3"]);
    expect(store.listMessagesSince(DEFAULT_TERA_ID, 3)).toEqual([]);
  });

  test("要約は Tera ごとに分かれる", () => {
    const store = makeStore();
    store.ensureTera("second", "2 体目");
    store.writeCompaction(DEFAULT_TERA_ID, {
      summary: "## Goal\n既定の要約。",
      throughSeq: 1,
      tokensBefore: 100,
      createdAt: 10,
    });

    expect(store.readCompaction(DEFAULT_TERA_ID).summary).toBe("## Goal\n既定の要約。");
    expect(store.readCompaction("second")).toEqual({
      summary: "",
      throughSeq: 0,
      tokensBefore: 0,
      createdAt: 0,
    });
  });

  test("いない Tera へは書けない", () => {
    const store = makeStore();
    // 要約は Tera の行に紐づく。書けてしまうと、どの Tera の要約か分からないまま残る。
    expect(() =>
      store.writeCompaction("missing", {
        summary: "## Goal\n要約。",
        throughSeq: 1,
        tokensBefore: 100,
        createdAt: 10,
      }),
    ).toThrow();
  });

  test("開き直しても要約はそのまま", () => {
    const path = join(tmpdir(), `terasuma-store-${crypto.randomUUID()}.db`);

    try {
      const first = createStore(path);
      first.writeCompaction(DEFAULT_TERA_ID, {
        summary: "## Goal\n残る要約。",
        throughSeq: 2,
        tokensBefore: 300,
        createdAt: 20,
      });
      first.close();

      const second = createStore(path);
      try {
        expect(second.readCompaction(DEFAULT_TERA_ID)).toEqual({
          summary: "## Goal\n残る要約。",
          throughSeq: 2,
          tokensBefore: 300,
          createdAt: 20,
        });
      } finally {
        second.close();
      }
    } finally {
      removeDatabase(path);
    }
  });
});

describe("listMessagesBetween", () => {
  /** 時刻を差し替えられるストア。日付の境界を作るために使う。 */
  function createClockStore(): { store: ReturnType<typeof createStore>; at: (time: number) => void } {
    let clock = new Date(2026, 9, 1, 0, 0).getTime();
    const store = createStore(":memory:", { now: () => clock });
    return {
      store,
      at: (time) => {
        clock = time;
      },
    };
  }

  /** 2026 年 10 月の、その日のローカル時刻。 */
  function localDay(day: number, hour = 0, minute = 0): number {
    return new Date(2026, 9, day, hour, minute).getTime();
  }

  test("since 以上 until 未満のメッセージを、古い順に返す", () => {
    const { store, at } = createClockStore();

    at(localDay(1, 23, 59));
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "前日" });
    at(localDay(2, 0, 0));
    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "user", content: "初日" });
    at(localDay(2, 23, 59));
    store.appendMessage({ id: "m3", teraId: DEFAULT_TERA_ID, role: "user", content: "同じ日" });
    at(localDay(3, 0, 0));
    store.appendMessage({ id: "m4", teraId: DEFAULT_TERA_ID, role: "user", content: "翌日" });

    const range = { since: localDay(2), until: localDay(3) };
    expect(store.listMessagesBetween(DEFAULT_TERA_ID, range).map((message) => message.content)).toEqual([
      "初日",
      "同じ日",
    ]);
  });

  test("端が null なら、その側は制限しない", () => {
    const { store, at } = createClockStore();

    at(localDay(1));
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "1 日" });
    at(localDay(2));
    store.appendMessage({ id: "m2", teraId: DEFAULT_TERA_ID, role: "user", content: "2 日" });

    expect(
      store.listMessagesBetween(DEFAULT_TERA_ID, { since: null, until: localDay(2) }).map((message) => message.content),
    ).toEqual(["1 日"]);
    expect(
      store.listMessagesBetween(DEFAULT_TERA_ID, { since: localDay(2), until: null }).map((message) => message.content),
    ).toEqual(["2 日"]);
    expect(
      store.listMessagesBetween(DEFAULT_TERA_ID, { since: null, until: null }).map((message) => message.content),
    ).toEqual(["1 日", "2 日"]);
  });

  test("別の Tera のメッセージは混ざらない", () => {
    const { store, at } = createClockStore();
    store.ensureTera("second", "2 体目");

    at(localDay(1));
    store.appendMessage({ id: "m1", teraId: DEFAULT_TERA_ID, role: "user", content: "既定へ" });
    store.appendMessage({ id: "m2", teraId: "second", role: "user", content: "2 体目へ" });

    expect(
      store.listMessagesBetween(DEFAULT_TERA_ID, { since: null, until: null }).map((message) => message.content),
    ).toEqual(["既定へ"]);
  });
});

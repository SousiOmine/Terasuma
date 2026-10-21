import { Database } from "bun:sqlite";
import { isChatAttachment, isMessagePart } from "../../shared/chat-event";
import type { ChatAttachment, ChatMessage, MessagePart, MessageRole, Tera, TokenUsage } from "../../shared/types";

/** 既存の assistant の本文を、画面に出す sent パーツへ移す版。 */
const CONTENT_TO_SENT_VERSION = 3;

/**
 * 既定の Tera。起動時に 1 体だけ用意する。
 * 増やす導線はまだ無いので、会話の持ち主は当面この 1 つになる。
 */
export const DEFAULT_TERA_ID = "default";
const DEFAULT_TERA_NAME = "Tera";

export type AppendMessageInput = {
  id: string;
  teraId: string;
  role: MessageRole;
  /** ユーザーが書いた本文。assistant では空で、表示する本文は parts の sent が持つ。 */
  content: string;
  /** ユーザーが添付したファイル。無ければ null。 */
  attachments?: ChatAttachment[] | null;
  /** ツール呼び出しを含むときだけ渡す。含まないメッセージは null。 */
  parts?: MessagePart[] | null;
  usage?: TokenUsage | null;
};

/**
 * Tera の過去のやり取りを畳んだ要約（Compaction）。
 * 会話が長くなっても、モデルへ渡す文脈を有界に保つ。
 */
export type CompactionState = {
  /** 定型（Goal / Progress など）で書かれた要約。まだ 1 度も畳んでいなければ空文字。 */
  summary: string;
  /** この seq までのメッセージは要約に畳み込まれた。まだ畳んでいなければ 0。 */
  throughSeq: number;
  /** 畳んだ時点の文脈のトークンの目安。 */
  tokensBefore: number;
  /** 要約を作った時刻。epoch ミリ秒。 */
  createdAt: number;
};

export type Store = {
  listTeras(): Tera[];
  getTera(id: string): Tera | null;
  /** 無ければ作る。既にあれば名前も作成日時も変えない（起動のたびに呼ばれる）。 */
  ensureTera(id: string, name: string): Tera;
  listMessages(teraId: string): ChatMessage[];
  /** seq より後のメッセージ（古い順）。まだ畳んでいない生の履歴を取り出す。 */
  listMessagesSince(teraId: string, seq: number): ChatMessage[];
  /** 履歴の末尾に追記する。Tera の行が先に存在している必要がある。 */
  appendMessage(input: AppendMessageInput): ChatMessage;
  readCompaction(teraId: string): CompactionState;
  /** 要約を置き換える。throughSeq は呼ぶ側が前に進める（戻さない）。 */
  writeCompaction(teraId: string, state: CompactionState): void;
  close(): void;
};

type TeraRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  tera_id: string;
  seq: number;
  role: string;
  content: string;
  attachments: string | null;
  parts: string | null;
  created_at: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
};

function toTera(row: TeraRow): Tera {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toMessage(row: MessageRow): ChatMessage {
  const usage =
    row.input_tokens === null && row.output_tokens === null && row.cached_input_tokens === null
      ? null
      : {
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          cachedInputTokens: row.cached_input_tokens ?? 0,
        };

  return {
    id: row.id,
    teraId: row.tera_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: row.content,
    attachments: readAttachments(row),
    parts: readParts(row),
    createdAt: row.created_at,
    usage,
  };
}

/** 画面に出す添付ファイルを読み戻す。読めない値は黙って捨てず、そのまま失敗させる。 */
function readAttachments(row: MessageRow): ChatAttachment[] | null {
  if (row.attachments === null) return null;

  const parsed: unknown = JSON.parse(row.attachments);
  if (!Array.isArray(parsed) || !parsed.every(isChatAttachment)) {
    throw new Error(`メッセージ ${row.id} の attachments は添付ファイルの配列ではありません`);
  }
  return parsed;
}

/** 保存されている部分を読み戻す。読めない値は黙って捨てず、そのまま失敗させる。 */
function readParts(row: MessageRow): MessagePart[] | null {
  if (row.parts === null) return null;

  const parsed: unknown = JSON.parse(row.parts);
  if (!Array.isArray(parsed) || !parsed.every(isMessagePart)) {
    throw new Error(`メッセージ ${row.id} の parts は部品の配列ではありません`);
  }
  return parsed;
}

export type CreateStoreOptions = {
  /** テストで時刻を固定するために差し替える。 */
  now?: () => number;
};

export function createStore(dbPath: string, options: CreateStoreOptions = {}): Store {
  const now = options.now ?? Date.now;
  const db = new Database(dbPath, { create: true });

  db.exec("PRAGMA journal_mode = WAL");
  // ON DELETE CASCADE が働くよう、接続ごとに有効にする必要がある。
  db.exec("PRAGMA foreign_keys = ON");

  migrateSchema(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS teras (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                  TEXT PRIMARY KEY,
      tera_id             TEXT NOT NULL REFERENCES teras (id) ON DELETE CASCADE,
      seq                 INTEGER NOT NULL,
      role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content             TEXT NOT NULL,
      attachments         TEXT,
      parts               TEXT,
      created_at          INTEGER NOT NULL,
      input_tokens        INTEGER,
      output_tokens       INTEGER,
      cached_input_tokens INTEGER,
      UNIQUE (tera_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_tera_seq ON messages (tera_id, seq);
    CREATE INDEX IF NOT EXISTS idx_teras_updated_at ON teras (updated_at DESC);

    CREATE TABLE IF NOT EXISTS compaction (
      tera_id       TEXT PRIMARY KEY REFERENCES teras (id) ON DELETE CASCADE,
      summary       TEXT NOT NULL,
      through_seq   INTEGER NOT NULL,
      tokens_before INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
  `);

  const selectTera = db.query<TeraRow, [string]>("SELECT id, name, created_at, updated_at FROM teras WHERE id = ?");
  const selectTeras = db.query<TeraRow, []>(
    "SELECT id, name, created_at, updated_at FROM teras ORDER BY updated_at DESC, created_at DESC",
  );
  const insertTera = db.query<unknown, [string, string, number, number]>(
    `INSERT INTO teras (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );
  const touchTera = db.query<unknown, [number, string]>("UPDATE teras SET updated_at = ? WHERE id = ?");

  const selectMessages = db.query<MessageRow, [string]>(
    `SELECT id, tera_id, seq, role, content, attachments, parts, created_at, input_tokens, output_tokens, cached_input_tokens
     FROM messages WHERE tera_id = ? ORDER BY seq ASC`,
  );
  const selectMessagesSince = db.query<MessageRow, [string, number]>(
    `SELECT id, tera_id, seq, role, content, attachments, parts, created_at, input_tokens, output_tokens, cached_input_tokens
     FROM messages WHERE tera_id = ? AND seq > ? ORDER BY seq ASC`,
  );
  const insertMessage = db.query<
    { seq: number },
    [
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      number,
      number | null,
      number | null,
      number | null,
    ]
  >(
    `INSERT INTO messages
       (id, tera_id, seq, role, content, attachments, parts, created_at, input_tokens, output_tokens, cached_input_tokens)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE tera_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING seq`,
  );

  const selectCompaction = db.query<
    { summary: string; through_seq: number; tokens_before: number; created_at: number },
    [string]
  >("SELECT summary, through_seq, tokens_before, created_at FROM compaction WHERE tera_id = ?");
  const upsertCompaction = db.query<unknown, [string, string, number, number, number]>(
    `INSERT INTO compaction (tera_id, summary, through_seq, tokens_before, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tera_id) DO UPDATE SET
       summary = excluded.summary,
       through_seq = excluded.through_seq,
       tokens_before = excluded.tokens_before,
       created_at = excluded.created_at`,
  );

  const append = db.transaction((input: AppendMessageInput): ChatMessage => {
    const at = now();
    const parts = input.parts ?? null;
    const attachments = input.attachments ?? null;

    // 連番は INSERT の中で決める（読み出してから書くまでの往復を減らす）。
    const inserted = insertMessage.get(
      input.id,
      input.teraId,
      input.teraId,
      input.role,
      input.content,
      attachments === null ? null : JSON.stringify(attachments),
      parts === null ? null : JSON.stringify(parts),
      at,
      input.usage?.inputTokens ?? null,
      input.usage?.outputTokens ?? null,
      input.usage?.cachedInputTokens ?? null,
    );
    const seq = inserted?.seq ?? 1;

    touchTera.run(at, input.teraId);

    return {
      id: input.id,
      teraId: input.teraId,
      seq,
      role: input.role,
      content: input.content,
      attachments,
      parts,
      createdAt: at,
      usage: input.usage ?? null,
    };
  });

  const store: Store = {
    listTeras() {
      return selectTeras.all().map(toTera);
    },

    getTera(id) {
      const row = selectTera.get(id);
      return row === null ? null : toTera(row);
    },

    ensureTera(id, name) {
      const at = now();
      insertTera.run(id, name, at, at);

      const row = selectTera.get(id);
      if (row === null) throw new Error(`Tera を作成できなかった: ${id}`);
      return toTera(row);
    },

    listMessages(teraId) {
      return selectMessages.all(teraId).map(toMessage);
    },

    listMessagesSince(teraId, seq) {
      return selectMessagesSince.all(teraId, seq).map(toMessage);
    },

    readCompaction(teraId) {
      const row = selectCompaction.get(teraId);
      return row === null
        ? { summary: "", throughSeq: 0, tokensBefore: 0, createdAt: 0 }
        : {
            summary: row.summary,
            throughSeq: row.through_seq,
            tokensBefore: row.tokens_before,
            createdAt: row.created_at,
          };
    },

    writeCompaction(teraId, state) {
      upsertCompaction.run(teraId, state.summary, state.throughSeq, state.tokensBefore, state.createdAt);
    },

    appendMessage(input) {
      return append(input);
    },

    close() {
      db.close();
    },
  };

  // 会話の持ち主が無いと何も始まらないので、起動時に 1 体だけ用意する。
  store.ensureTera(DEFAULT_TERA_ID, DEFAULT_TERA_NAME);
  return store;
}

/** いまの保存の形の版。形を変えたら上げ、migrateSchema に移行を足す。 */
const SCHEMA_VERSION = 3;

/**
 * 保存の形を、いまの版に合わせる。
 * user_version を使い、移行は 1 回だけ走らせる（起動のたびに古いテーブルを調べ直さない）。
 */
function migrateSchema(db: Database): void {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const version = row?.user_version ?? 0;
  if (version >= SCHEMA_VERSION) return;

  dropLegacyTables(db);
  ensureMessageColumns(db);
  if (version < CONTENT_TO_SENT_VERSION) moveAssistantContentToSent(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * v2 までの assistant の本文を、画面に出す sent パーツへ移す。
 *
 * 以前は content をそのまま画面に出していた。いまは画面が parts の sent だけを読むので、
 * そのままにすると過去の返事がどこにも表示されなくなる。本文はモデルへ渡す履歴にも
 * 必要なので text として残し、同じ文を sent として足す。
 */
function moveAssistantContentToSent(db: Database): void {
  if (!tableExists(db, "messages")) return;

  const rows = db
    .query<LegacyAssistantRow, []>("SELECT id, content, parts, created_at FROM messages WHERE role = 'assistant'")
    .all();
  if (rows.length === 0) return;

  const update = db.query<unknown, [string, string]>("UPDATE messages SET content = '', parts = ? WHERE id = ?");
  const migrate = db.transaction(() => {
    for (const row of rows) update.run(JSON.stringify(sentPartsFromLegacy(row)), row.id);
  });
  migrate();
}

type LegacyAssistantRow = {
  id: string;
  content: string;
  parts: string | null;
  created_at: number;
};

/** 移行前の 1 行を、いまの形（text と sent の並び）に開く。 */
function sentPartsFromLegacy(row: LegacyAssistantRow): MessagePart[] {
  const at = row.created_at;

  if (row.parts === null) {
    if (row.content.length === 0) return [];
    return [
      { type: "text", text: row.content },
      { type: "sent", text: row.content, attachments: [], at },
    ];
  }

  const parsed: unknown = JSON.parse(row.parts);
  if (!Array.isArray(parsed) || !parsed.every(isMessagePart)) {
    throw new Error(`メッセージ ${row.id} の parts を移行できませんでした`);
  }

  const parts: MessagePart[] = [];
  for (const part of parsed) {
    parts.push(part);
    if (part.type === "text" && part.text.length > 0) {
      parts.push({ type: "sent", text: part.text, attachments: [], at });
    }
  }
  return parts;
}

/** テーブルがあるかどうか（移行の前に、まだ作られていないテーブルを触らないため）。 */
function tableExists(db: Database, name: string): boolean {
  const row = db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== null;
}

/**
 * メッセージの列を、いまの形に合わせる。
 * attachments は v2 で増えた。既存のメッセージには添付の記録が無いので、null のままにする。
 */
function ensureMessageColumns(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
  if (columns.length === 0) return;

  const names = new Set(columns.map((column) => column.name));
  if (!names.has("attachments")) {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  }
}

/**
 * 古い形のテーブルを落とす。
 *
 * セッションごとに会話を分けていた頃のテーブルは、会話の持ち主（セッション → Tera）が
 * 変わったため引き継げない（どの Tera の履歴なのか決められない）。messages を先に落とす
 * （sessions を参照しているため）。
 *
 * 観察の記録（Observational Memory）で畳んでいた頃のテーブルは、生のメッセージが残るので
 * 落としてよい。次の圧縮で、要約を作り直す。
 */
function dropLegacyTables(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
  const legacySessions = columns.length > 0 && columns.every((column) => column.name !== "tera_id");
  if (legacySessions) db.exec("DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS sessions;");

  db.exec("DROP TABLE IF EXISTS observations;");
}

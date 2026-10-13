import { Database } from "bun:sqlite";
import type { ChatMessage, MessageRole, Session, TokenUsage } from "../shared/types";

export const TITLE_MAX_LENGTH = 40;

/** 最初のユーザー発言からセッションのタイトルを作る。空なら null（表示文言はクライアントが決める）。 */
export function deriveTitle(text: string): string | null {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstLine === undefined) return null;
  return firstLine.length > TITLE_MAX_LENGTH ? `${firstLine.slice(0, TITLE_MAX_LENGTH)}…` : firstLine;
}

export type AppendMessageInput = {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  usage?: TokenUsage | null;
};

export type Store = {
  listSessions(): Session[];
  getSession(id: string): Session | null;
  /** 無ければ作る。既にあればタイトルも作成日時も変えない。 */
  ensureSession(id: string, titleSource: string | null): Session;
  renameSession(id: string, title: string): boolean;
  deleteSession(id: string): boolean;
  listMessages(sessionId: string): ChatMessage[];
  /** 履歴の末尾に追記する。セッション行が先に存在している必要がある。 */
  appendMessage(input: AppendMessageInput): ChatMessage;
  close(): void;
};

type SessionRow = {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  created_at: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
};

function toSession(row: SessionRow): Session {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
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
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: row.content,
    createdAt: row.created_at,
    usage,
  };
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                  TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      seq                 INTEGER NOT NULL,
      role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content             TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      input_tokens        INTEGER,
      output_tokens       INTEGER,
      cached_input_tokens INTEGER,
      UNIQUE (session_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages (session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);
  `);

  const selectSession = db.query<SessionRow, [string]>(
    "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?",
  );
  const selectSessions = db.query<SessionRow, []>(
    "SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC, created_at DESC",
  );
  const insertSession = db.query<unknown, [string, string | null, number, number]>(
    `INSERT INTO sessions (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );
  const updateSessionTitle = db.query<unknown, [string, number, string]>(
    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
  );
  const setSessionTitleIfEmpty = db.query<unknown, [string, number, string]>(
    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND title IS NULL",
  );
  const touchSession = db.query<unknown, [number, string]>(
    "UPDATE sessions SET updated_at = ? WHERE id = ?",
  );
  const deleteSessionStmt = db.query<unknown, [string]>("DELETE FROM sessions WHERE id = ?");

  const selectMessages = db.query<MessageRow, [string]>(
    `SELECT id, session_id, seq, role, content, created_at, input_tokens, output_tokens, cached_input_tokens
     FROM messages WHERE session_id = ? ORDER BY seq ASC`,
  );
  const selectNextSeq = db.query<{ next_seq: number }, [string]>(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE session_id = ?",
  );
  const insertMessage = db.query<
    unknown,
    [string, string, number, string, string, number, number | null, number | null, number | null]
  >(
    `INSERT INTO messages
       (id, session_id, seq, role, content, created_at, input_tokens, output_tokens, cached_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const append = db.transaction((input: AppendMessageInput): ChatMessage => {
    const at = now();
    const seq = selectNextSeq.get(input.sessionId)?.next_seq ?? 1;

    insertMessage.run(
      input.id,
      input.sessionId,
      seq,
      input.role,
      input.content,
      at,
      input.usage?.inputTokens ?? null,
      input.usage?.outputTokens ?? null,
      input.usage?.cachedInputTokens ?? null,
    );
    touchSession.run(at, input.sessionId);

    if (input.role === "user") {
      const title = deriveTitle(input.content);
      if (title !== null) setSessionTitleIfEmpty.run(title, at, input.sessionId);
    }

    return {
      id: input.id,
      sessionId: input.sessionId,
      seq,
      role: input.role,
      content: input.content,
      createdAt: at,
      usage: input.usage ?? null,
    };
  });

  return {
    listSessions() {
      return selectSessions.all().map(toSession);
    },

    getSession(id) {
      const row = selectSession.get(id);
      return row === null ? null : toSession(row);
    },

    ensureSession(id, titleSource) {
      const at = now();
      const title = titleSource === null ? null : deriveTitle(titleSource);
      insertSession.run(id, title, at, at);

      const row = selectSession.get(id);
      if (row === null) throw new Error(`セッションを作成できなかった: ${id}`);
      return toSession(row);
    },

    renameSession(id, title) {
      const trimmed = title.trim();
      if (trimmed.length === 0) return false;
      return updateSessionTitle.run(trimmed, now(), id).changes > 0;
    },

    deleteSession(id) {
      return deleteSessionStmt.run(id).changes > 0;
    },

    listMessages(sessionId) {
      return selectMessages.all(sessionId).map(toMessage);
    },

    appendMessage(input) {
      return append(input);
    },

    close() {
      db.close();
    },
  };
}

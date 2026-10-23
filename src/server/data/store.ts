import { Database } from "bun:sqlite";
import { isChatAttachment, isMessagePart, isSentAttachment } from "../../shared/chat-event";
import { CHAT_SERVER_ID } from "../../shared/tools";
import type {
  ChatAttachment,
  ChatMessage,
  MessagePage,
  MessagePart,
  MessageRole,
  SentAttachment,
  Tera,
  TokenUsage,
} from "../../shared/types";

/** v2 までの assistant の本文を、parts の text へ移す版。 */
const MESSAGE_CONTENT_VERSION = 3;

/** v3 までの sent を、画面に出す text と attachment へ分ける版。 */
const VISIBLE_TEXT_VERSION = 4;

/** v3 で本文を送っていたツールの名前。移行のときだけ参照する。 */
const LEGACY_SEND_TOOL = "send";

/**
 * 既定の Tera。起動時に 1 体だけ用意する。
 * 増やす導線はまだ無いので、会話の持ち主は当面この 1 つになる。
 */
export const DEFAULT_TERA_ID = "default";
const DEFAULT_TERA_NAME = "Tera";

/**
 * 既定の identity。Tera が自分で書き換える出発点になる。
 * system プロンプトに常に載るので、短く保つ。
 */
export const DEFAULT_TERA_IDENTITY = [
  "# Role",
  "",
  "You are a general-purpose assistant for the user. You run on their own machine and answer in this chat.",
  "You help with whatever they bring: questions, writing and changing code, the desktop container, and web research.",
].join("\n");

export type AppendMessageInput = {
  id: string;
  teraId: string;
  role: MessageRole;
  /** ユーザーが書いた本文。assistant では空で、表示する本文は parts の text が持つ。 */
  content: string;
  /** ユーザーが添付したファイル。無ければ null。 */
  attachments?: ChatAttachment[] | null;
  /** ツール呼び出しを含むときだけ渡す。含まないメッセージは null。 */
  parts?: MessagePart[] | null;
  usage?: TokenUsage | null;
};

/** 履歴を読むページ。before は「この seq より前」を表し、null なら最新から読む。 */
export type MessagePageQuery = {
  /** 返す件数の上限。 */
  limit: number;
  /** この seq より前だけを読む。null なら最新から。 */
  before: number | null;
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

/**
 * Tera の identity（自分の役割と、必要な知識）。
 *
 * content は Tera が identity ツールで書いた最新の本文。
 * applied は system プロンプトに載っている版で、最後に圧縮が要約を書き換えた時点の content が入る。
 * system プロンプトは applied だけを読むので、書き換えただけでは次の圧縮まで変わらない。
 */
export type TeraIdentity = {
  content: string;
  applied: string;
};

export type Store = {
  listTeras(): Tera[];
  getTera(id: string): Tera | null;
  /**
   * 無ければ作る。既にあれば名前も作成日時も変えない（起動のたびに呼ばれる）。
   * identity も無ければ既定の役割で作り、既にあれば変えない。
   */
  ensureTera(id: string, name: string): Tera;
  /**
   * 履歴を新しい側から 1 ページ読む（返す並びは古い順）。
   * limit は件数の上限、before は「この seq より前」を表す。
   */
  listMessagesPage(teraId: string, page: MessagePageQuery): MessagePage;
  /** seq より後のメッセージ（古い順）。まだ畳んでいない生の履歴を取り出す。 */
  listMessagesSince(teraId: string, seq: number): ChatMessage[];
  /**
   * 期間で絞ったメッセージ（古い順）。since 以上 until 未満。
   * 端は null で「制限しない」を表す（0 時と 0 を取り違えないよう、時刻ではなく null で表す）。
   */
  listMessagesBetween(teraId: string, range: { since: number | null; until: number | null }): ChatMessage[];
  /** 履歴の末尾に追記する。Tera の行が先に存在している必要がある。 */
  appendMessage(input: AppendMessageInput): ChatMessage;
  readCompaction(teraId: string): CompactionState;
  /** 要約を置き換える。throughSeq は呼ぶ側が前に進める（戻さない）。 */
  writeCompaction(teraId: string, state: CompactionState): void;
  /** Tera の identity を読む。まだ書かれていなければ、どちらも空。 */
  readIdentity(teraId: string): TeraIdentity;
  /** Tera が書いた identity を置き換える。system プロンプト用の版（applied）は変えない。 */
  writeIdentity(teraId: string, content: string): TeraIdentity;
  /**
   * 書かれている identity を、system プロンプト用の版へ切り替える。
   * 圧縮が要約を書き換えたときに呼ぶ。変わったときだけ true。
   */
  applyIdentity(teraId: string): boolean;
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

    CREATE TABLE IF NOT EXISTS tera_identity (
      tera_id TEXT PRIMARY KEY REFERENCES teras (id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      applied TEXT NOT NULL
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

  // 新しい側から limit + 1 件読み、1 件余ったら「さらに古い発言がある」と分かる。
  const selectMessagePage = db.query<MessageRow, [string, number | null, number | null, number]>(
    `SELECT id, tera_id, seq, role, content, attachments, parts, created_at, input_tokens, output_tokens, cached_input_tokens
     FROM messages
     WHERE tera_id = ? AND (? IS NULL OR seq < ?)
     ORDER BY seq DESC
     LIMIT ?`,
  );
  const selectMessagesSince = db.query<MessageRow, [string, number]>(
    `SELECT id, tera_id, seq, role, content, attachments, parts, created_at, input_tokens, output_tokens, cached_input_tokens
     FROM messages WHERE tera_id = ? AND seq > ? ORDER BY seq ASC`,
  );
  // 端が null のときは、その側を制限しない。4 通りの組み合わせを 1 本の文で受ける。
  const selectMessagesBetween = db.query<
    MessageRow,
    [string, number | null, number | null, number | null, number | null]
  >(
    `SELECT id, tera_id, seq, role, content, attachments, parts, created_at, input_tokens, output_tokens, cached_input_tokens
     FROM messages
     WHERE tera_id = ?
       AND (? IS NULL OR created_at >= ?)
       AND (? IS NULL OR created_at < ?)
     ORDER BY seq ASC`,
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

  const selectIdentity = db.query<{ content: string; applied: string }, [string]>(
    "SELECT content, applied FROM tera_identity WHERE tera_id = ?",
  );
  // 行が無ければ applied を空で作る。既にあれば content だけを書き換え、applied は据え置く。
  const upsertIdentity = db.query<unknown, [string, string]>(
    `INSERT INTO tera_identity (tera_id, content, applied) VALUES (?, ?, '')
     ON CONFLICT (tera_id) DO UPDATE SET content = excluded.content`,
  );
  const insertIdentityIfMissing = db.query<unknown, [string, string, string]>(
    `INSERT INTO tera_identity (tera_id, content, applied) VALUES (?, ?, ?)
     ON CONFLICT (tera_id) DO NOTHING`,
  );
  // 変わる行が無ければ changes は 0 になる（同じ内容での切り替えを「変化なし」と呼べる）。
  const switchIdentity = db.query<unknown, [string]>(
    "UPDATE tera_identity SET applied = content WHERE tera_id = ? AND content <> applied",
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
      // identity の行が無いときだけ、既定の役割を入れる（書かれている本文は変えない）。
      insertIdentityIfMissing.run(id, DEFAULT_TERA_IDENTITY, DEFAULT_TERA_IDENTITY);

      const row = selectTera.get(id);
      if (row === null) throw new Error(`Tera を作成できなかった: ${id}`);
      return toTera(row);
    },

    listMessagesPage(teraId, page) {
      const rows = selectMessagePage.all(teraId, page.before, page.before, page.limit + 1);
      const hasMore = rows.length > page.limit;
      const pageRows = hasMore ? rows.slice(0, page.limit) : rows;

      return { messages: pageRows.reverse().map(toMessage), hasMore };
    },

    listMessagesSince(teraId, seq) {
      return selectMessagesSince.all(teraId, seq).map(toMessage);
    },

    listMessagesBetween(teraId, range) {
      return selectMessagesBetween.all(teraId, range.since, range.since, range.until, range.until).map(toMessage);
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

    readIdentity(teraId) {
      const row = selectIdentity.get(teraId);
      return row === null ? { content: "", applied: "" } : { content: row.content, applied: row.applied };
    },

    writeIdentity(teraId, content) {
      upsertIdentity.run(teraId, content);

      const row = selectIdentity.get(teraId);
      if (row === null) throw new Error(`identity を保存できませんでした: ${teraId}`);
      return { content: row.content, applied: row.applied };
    },

    applyIdentity(teraId) {
      return switchIdentity.run(teraId).changes > 0;
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

/**
 * いまの保存の形の版。形を変えたら上げ、migrateSchema に移行を足す。
 * 新しいテーブルは CREATE TABLE IF NOT EXISTS が作るので、移行の関数は要らない（v5 で tera_identity を足した）。
 */
const SCHEMA_VERSION = 5;

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
  if (version < MESSAGE_CONTENT_VERSION) moveLegacyAssistantContent(db);
  if (version < VISIBLE_TEXT_VERSION) moveSentToVisibleParts(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

type LegacyAssistantRow = {
  id: string;
  content: string;
  parts: string | null;
  created_at: number;
};

/**
 * v2 までの assistant の本文を、画面に出す text パーツへ移す。
 *
 * 以前は content をそのまま画面に出していた。いまは本文を parts の text から読む。
 * parts があるときは、そちらの text が画面に出ていた本文なので content は使わない
 * （v2 では content と parts の text が同じ文を二重に持っていた）。
 */
function moveLegacyAssistantContent(db: Database): void {
  if (!tableExists(db, "messages")) return;

  const rows = db
    .query<LegacyAssistantRow, []>("SELECT id, content, parts, created_at FROM messages WHERE role = 'assistant'")
    .all();
  if (rows.length === 0) return;

  const update = db.query<unknown, [string, string]>("UPDATE messages SET content = '', parts = ? WHERE id = ?");
  const migrate = db.transaction(() => {
    for (const row of rows) update.run(JSON.stringify(legacyParts(row)), row.id);
  });
  migrate();
}

/**
 * v3 までの sent を、画面に出す text と attachment に分ける。
 *
 * text は v3 ではモデル向けの内部の記録だったが、いまは画面にも出す。同じ文を sent にも
 * 持つ場合は text の位置だけを残し、二重にしない。sent の本文が text に無ければ sent の位置に足す。
 *
 * chat_send の呼び出しと結果は、いまのツールに無い。履歴に残すと、次のターンで知らない
 * ツールの呼び出しとしてプロバイダに拒まれることがあるので、この組は落とす。
 */
function moveSentToVisibleParts(db: Database): void {
  if (!tableExists(db, "messages")) return;

  const rows = db
    .query<LegacyAssistantRow, []>("SELECT id, content, parts, created_at FROM messages WHERE role = 'assistant'")
    .all();
  if (rows.length === 0) return;

  const update = db.query<unknown, [string, string]>("UPDATE messages SET content = '', parts = ? WHERE id = ?");
  const migrate = db.transaction(() => {
    for (const row of rows) update.run(JSON.stringify(visiblePartsFromLegacy(row)), row.id);
  });
  migrate();
}

/** v2 までの 1 行を、いまの形（text は at を持つ）に開く。 */
function legacyParts(row: LegacyAssistantRow): MessagePart[] {
  if (row.parts === null) {
    if (row.content.length === 0) return [];
    return [{ type: "text", text: row.content, at: row.created_at }];
  }

  const parts: MessagePart[] = [];
  for (const part of parseLegacyParts(row.parts, row.id)) {
    if (part.type === "text") {
      if (part.text.length > 0) parts.push({ type: "text", text: part.text, at: row.created_at });
      continue;
    }
    if (part.type === "sent") {
      if (part.text.length > 0) parts.push({ type: "text", text: part.text, at: part.at });
      if (part.attachments.length > 0) {
        parts.push({ type: "attachment", attachments: part.attachments, at: part.at });
      }
      continue;
    }
    parts.push(part);
  }
  return parts;
}

/** v3 までの 1 行を、いまの形に開く。 */
function visiblePartsFromLegacy(row: LegacyAssistantRow): MessagePart[] {
  if (row.parts === null) {
    if (row.content.length === 0) return [];
    return [{ type: "text", text: row.content, at: row.created_at }];
  }

  const parsed = parseLegacyParts(row.parts, row.id);
  const texts = new Set(
    parsed
      .filter((part): part is Extract<LegacyPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text),
  );

  const parts: MessagePart[] = [];
  for (const part of parsed) {
    if (part.type === "text") {
      if (part.text.length > 0) parts.push({ type: "text", text: part.text, at: part.at ?? row.created_at });
      continue;
    }
    if (part.type === "sent") {
      if (part.text.length > 0 && !texts.has(part.text)) {
        parts.push({ type: "text", text: part.text, at: part.at });
      }
      if (part.attachments.length > 0) {
        parts.push({ type: "attachment", attachments: part.attachments, at: part.at });
      }
      continue;
    }
    parts.push(part);
  }

  return dropLegacySendParts(parts);
}

/** 移行の前に保存されていた部品。text は at を持たないことがある。 */
type LegacyPart =
  | { type: "text"; text: string; at?: number }
  | { type: "sent"; text: string; attachments: SentAttachment[]; at: number }
  | Extract<MessagePart, { type: "notice" | "tool-call" | "tool-result" }>;

/** 保存されていた parts を、移行前の形として読む。壊れた値は黙って捨てず、そのまま失敗させる。 */
function parseLegacyParts(raw: string, messageId: string): LegacyPart[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`メッセージ ${messageId} の parts は部品の配列ではありません`);
  }

  return parsed.map((part) => {
    if (typeof part !== "object" || part === null) {
      throw new Error(`メッセージ ${messageId} の parts に、読めない部品があります`);
    }

    const value = part as Record<string, unknown>;
    switch (value.type) {
      case "text":
        if (typeof value.text !== "string") {
          throw new Error(`メッセージ ${messageId} の text 部品に本文がありません`);
        }
        return typeof value.at === "number"
          ? { type: "text", text: value.text, at: value.at }
          : { type: "text", text: value.text };
      case "sent": {
        const attachments = value.attachments;
        if (
          typeof value.text !== "string" ||
          typeof value.at !== "number" ||
          !Array.isArray(attachments) ||
          !attachments.every(isSentAttachment)
        ) {
          throw new Error(`メッセージ ${messageId} の sent 部品が壊れています`);
        }
        return { type: "sent", text: value.text, attachments, at: value.at };
      }
      case "notice":
      case "tool-call":
      case "tool-result":
        if (!isMessagePart(value)) {
          throw new Error(`メッセージ ${messageId} の ${String(value.type)} 部品が壊れています`);
        }
        return value as Extract<MessagePart, { type: "notice" | "tool-call" | "tool-result" }>;
      default:
        throw new Error(`メッセージ ${messageId} の parts に、知らない部品があります`);
    }
  });
}

/** v3 で使っていた chat_send の呼び出しと結果を、履歴から落とす。 */
function dropLegacySendParts(parts: MessagePart[]): MessagePart[] {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.type === "tool-call" && part.server === CHAT_SERVER_ID && part.tool === LEGACY_SEND_TOOL) {
      ids.add(part.id);
    }
  }
  if (ids.size === 0) return parts;

  return parts.filter((part) => !((part.type === "tool-call" || part.type === "tool-result") && ids.has(part.id)));
}

/** テーブルがあるかどうか（移行の前に、まだ作られていないテーブルを触らないため）。 */
function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
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

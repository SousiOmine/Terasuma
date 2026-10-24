import type { Database } from "bun:sqlite";
import { isMessagePart, isSentAttachment } from "../../../shared/chat-event";
import { CHAT_SERVER_ID } from "../../../shared/tools";
import type { MessagePart, SentAttachment } from "../../../shared/api/message";
import { SCHEMA_VERSION } from "./schema";

/**
 * 過去の版で保存した形を、いまの形へ移す。
 *
 * 起動時に 1 回だけ走る（PRAGMA user_version）。日常の読み書きには関わらない。
 */

/** v2 までの assistant の本文を、parts の text へ移す版。 */
const MESSAGE_CONTENT_VERSION = 3;

/** v3 までの sent を、画面に出す text と attachment へ分ける版。 */
const VISIBLE_TEXT_VERSION = 4;

/** v3 で本文を送っていたツールの名前。移行のときだけ参照する。 */
const LEGACY_SEND_TOOL = "send";

export function migrateSchema(db: Database): void {
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
 * attachments は v2、origin は v6 で増えた。既存のメッセージには記録が無いので、null のままにする。
 */
function ensureMessageColumns(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
  if (columns.length === 0) return;

  const names = new Set(columns.map((column) => column.name));
  if (!names.has("attachments")) {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  }
  if (!names.has("origin")) {
    db.exec("ALTER TABLE messages ADD COLUMN origin TEXT");
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

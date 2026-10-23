import { Database } from "bun:sqlite";
import type { ChatMessage } from "../../../shared/api/message";
import { migrateSchema } from "./migrations";
import { prepareQueries } from "./queries";
import { toMessage, toTera } from "./rows";
import { createSchema } from "./schema";
import {
  DEFAULT_TERA_ID,
  DEFAULT_TERA_IDENTITY,
  DEFAULT_TERA_NAME,
  type AppendMessageInput,
  type CreateStoreOptions,
  type Store,
} from "./types";

/**
 * 会話の保存先（SQLite）。
 *
 * 起動時に形を整え、履歴の追記と読み出し、要約、identity を持つ。
 * 過去版の移行は ./migrations.ts、行の変換は ./rows.ts、SQL は ./queries.ts にある。
 */

export { DEFAULT_TERA_ID, DEFAULT_TERA_IDENTITY } from "./types";
export type {
  AppendMessageInput,
  CompactionState,
  CompactionStore,
  CreateStoreOptions,
  MessageLog,
  MessagePageQuery,
  MessagePageResult,
  Store,
  TeraDirectory,
  TeraIdentity,
  TeraIdentityStore,
} from "./types";

export function createStore(dbPath: string, options: CreateStoreOptions = {}): Store {
  const now = options.now ?? Date.now;
  const db = new Database(dbPath, { create: true });

  db.exec("PRAGMA journal_mode = WAL");
  // ON DELETE CASCADE が働くよう、接続ごとに有効にする必要がある。
  db.exec("PRAGMA foreign_keys = ON");

  migrateSchema(db);

  createSchema(db);

  const q = prepareQueries(db);

  const append = db.transaction((input: AppendMessageInput): ChatMessage => {
    const at = now();
    const parts = input.parts ?? null;
    const attachments = input.attachments ?? null;

    // 連番は INSERT の中で決める（読み出してから書くまでの往復を減らす）。
    const inserted = q.insertMessage.get(
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

    q.touchTera.run(at, input.teraId);

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
      return q.selectTeras.all().map(toTera);
    },

    getTera(id) {
      const row = q.selectTera.get(id);
      return row === null ? null : toTera(row);
    },

    ensureTera(id, name) {
      const at = now();
      q.insertTera.run(id, name, at, at);
      // identity の行が無いときだけ、既定の役割を入れる（書かれている本文は変えない）。
      q.insertIdentityIfMissing.run(id, DEFAULT_TERA_IDENTITY, DEFAULT_TERA_IDENTITY);

      const row = q.selectTera.get(id);
      if (row === null) throw new Error(`Tera を作成できなかった: ${id}`);
      return toTera(row);
    },

    listMessagesPage(teraId, page) {
      const rows = q.selectMessagePage.all(teraId, page.before, page.before, page.limit + 1);
      const hasMore = rows.length > page.limit;
      const pageRows = hasMore ? rows.slice(0, page.limit) : rows;

      return { messages: pageRows.reverse().map(toMessage), hasMore };
    },

    listMessagesSince(teraId, seq) {
      return q.selectMessagesSince.all(teraId, seq).map(toMessage);
    },

    listMessagesBetween(teraId, range) {
      return q.selectMessagesBetween.all(teraId, range.since, range.since, range.until, range.until).map(toMessage);
    },

    readCompaction(teraId) {
      const row = q.selectCompaction.get(teraId);
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
      q.upsertCompaction.run(teraId, state.summary, state.throughSeq, state.tokensBefore, state.createdAt);
    },

    readIdentity(teraId) {
      const row = q.selectIdentity.get(teraId);
      return row === null ? { content: "", applied: "" } : { content: row.content, applied: row.applied };
    },

    writeIdentity(teraId, content) {
      q.upsertIdentity.run(teraId, content);

      const row = q.selectIdentity.get(teraId);
      if (row === null) throw new Error(`identity を保存できませんでした: ${teraId}`);
      return { content: row.content, applied: row.applied };
    },

    applyIdentity(teraId) {
      return q.switchIdentity.run(teraId).changes > 0;
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

import type { Database } from "bun:sqlite";

/**
 * テーブルの定義。
 *
 * 形を変えたら SCHEMA_VERSION を上げ、migrations.ts に移行を足す。
 * 新しいテーブルは CREATE TABLE IF NOT EXISTS が作るので、移行の関数は要らない
 * （v5 で tera_identity を足した）。
 */

export const SCHEMA_VERSION = 5;

export function createSchema(db: Database): void {
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
}

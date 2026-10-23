import type { Database } from "bun:sqlite";
import type { MessageRow, TeraRow } from "./rows";

/**
 * プリペアドステートメント。
 *
 * メッセージの列は 3 本の SELECT で同じ並びを使うので、1 つの定数にまとめる。
 * 列を足すときはここだけを直す。
 */

/** メッセージ 1 行の列。SELECT の並びを 1 か所に揃える。 */
const MESSAGE_COLUMNS =
  "id, tera_id, seq, role, content, attachments, parts, created_at, input_tokens, output_tokens, cached_input_tokens";

export function prepareQueries(db: Database) {
  const selectTera = db.query<TeraRow, [string]>("SELECT id, name, created_at, updated_at FROM teras WHERE id = ?");
  const selectTeras = db.query<TeraRow, []>(
    "SELECT id, name, created_at, updated_at FROM teras ORDER BY updated_at DESC, created_at DESC",
  );
  const selectTeraByName = db.query<TeraRow, [string]>(
    "SELECT id, name, created_at, updated_at FROM teras WHERE name = ?",
  );
  const insertTera = db.query<unknown, [string, string, number, number]>(
    `INSERT INTO teras (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );
  // createTera 用。同じ id があれば黙って通さず、制約違反で失敗させる。
  const insertTeraNew = db.query<unknown, [string, string, number, number]>(
    `INSERT INTO teras (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  const touchTera = db.query<unknown, [number, string]>("UPDATE teras SET updated_at = ? WHERE id = ?");

  // 新しい側から limit + 1 件読み、1 件余ったら「さらに古い発言がある」と分かる。
  const selectMessagePage = db.query<MessageRow, [string, number | null, number | null, number]>(
    `SELECT ${MESSAGE_COLUMNS}
     FROM messages
     WHERE tera_id = ? AND (? IS NULL OR seq < ?)
     ORDER BY seq DESC
     LIMIT ?`,
  );
  const selectMessagesSince = db.query<MessageRow, [string, number]>(
    `SELECT ${MESSAGE_COLUMNS}
     FROM messages WHERE tera_id = ? AND seq > ? ORDER BY seq ASC`,
  );
  // 端が null のときは、その側を制限しない。4 通りの組み合わせを 1 本の文で受ける。
  const selectMessagesBetween = db.query<
    MessageRow,
    [string, number | null, number | null, number | null, number | null]
  >(
    `SELECT ${MESSAGE_COLUMNS}
     FROM messages
     WHERE tera_id = ?
       AND (? IS NULL OR created_at >= ?)
       AND (? IS NULL OR created_at < ?)
     ORDER BY seq ASC`,
  );
  // 圧縮の要否を、全行を JSON として開かずに見るための統計。
  const selectPendingStats = db.query<
    { count: number; last_created_at: number | null; chars: number | null },
    [string, number]
  >(
    `SELECT COUNT(*) AS count, MAX(created_at) AS last_created_at,
            SUM(LENGTH(content) + COALESCE(LENGTH(parts), 0)) AS chars
     FROM messages WHERE tera_id = ? AND seq > ?`,
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
       (${MESSAGE_COLUMNS})
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
  // createTera 用。新しい Tera に、最初から system プロンプトへ載せる版を入れる。
  const insertIdentity = db.query<unknown, [string, string, string]>(
    `INSERT INTO tera_identity (tera_id, content, applied) VALUES (?, ?, ?)`,
  );
  // 変わる行が無ければ changes は 0 になる（同じ内容での切り替えを「変化なし」と呼べる）。
  const switchIdentity = db.query<unknown, [string]>(
    "UPDATE tera_identity SET applied = content WHERE tera_id = ? AND content <> applied",
  );

  return {
    selectTera,
    selectTeras,
    selectTeraByName,
    insertTera,
    insertTeraNew,
    touchTera,
    selectMessagePage,
    selectMessagesSince,
    selectMessagesBetween,
    selectPendingStats,
    insertMessage,
    selectCompaction,
    upsertCompaction,
    selectIdentity,
    upsertIdentity,
    insertIdentityIfMissing,
    insertIdentity,
    switchIdentity,
  };
}

export type Queries = ReturnType<typeof prepareQueries>;

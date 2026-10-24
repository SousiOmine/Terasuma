import type { Database } from "bun:sqlite";
import type { MessageRow, RoutineRow, TeraRow } from "./rows";

/**
 * プリペアドステートメント。
 *
 * メッセージの列は 3 本の SELECT で同じ並びを使うので、1 つの定数にまとめる。
 * 列を足すときはここだけを直す。
 */

/** メッセージ 1 行の列。SELECT の並びを 1 か所に揃える。 */
const MESSAGE_COLUMNS =
  "id, tera_id, seq, role, content, attachments, parts, origin, created_at, input_tokens, output_tokens, cached_input_tokens";

/** ルーチン 1 行の列。SELECT ごとに並びがずれないよう、ここにまとめる。 */
const ROUTINE_COLUMNS =
  "id, tera_id, name, prompt, schedule, enabled, next_run_at, last_run_at, last_status, last_detail, created_at, updated_at";
const ROUTINE_COLUMNS_WITH_TERA = `r.${ROUTINE_COLUMNS.replaceAll(", ", ", r.")}`;

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
  // 履歴・要約・identity は、外部キーの ON DELETE CASCADE で一緒に消える。
  const deleteTera = db.query<unknown, [string]>("DELETE FROM teras WHERE id = ?");

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
  // 画面が履歴を取り直すべきかを決めるための、最新の連番。1 件も無ければ 0 が返る。
  const selectLastSeq = db.query<{ seq: number }, [string]>(
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE tera_id = ?",
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
  const updateMessageParts = db.query<
    unknown,
    [string, number | null, number | null, number | null, string]
  >(
    `UPDATE messages
        SET parts = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?
      WHERE id = ?`,
  );
  const selectMessageById = db.query<MessageRow, [string]>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`);
  const deleteMessageById = db.query<unknown, [string]>("DELETE FROM messages WHERE id = ?");
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
      string | null,
      number,
      number | null,
      number | null,
      number | null,
    ]
  >(
    `INSERT INTO messages
       (${MESSAGE_COLUMNS})
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE tera_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING seq`,
  );

  // 一覧は Tera の並び（更新の新しい順）に合わせ、その中は作成順にする。
  const selectRoutines = db.query<RoutineRow, []>(
    `SELECT ${ROUTINE_COLUMNS_WITH_TERA}
       FROM routines r JOIN teras t ON t.id = r.tera_id
      ORDER BY t.updated_at DESC, t.created_at DESC, r.created_at ASC, r.rowid ASC`,
  );
  const selectRoutinesOf = db.query<RoutineRow, [string]>(
    `SELECT ${ROUTINE_COLUMNS} FROM routines WHERE tera_id = ? ORDER BY created_at ASC, rowid ASC`,
  );
  const selectRoutineById = db.query<RoutineRow, [string]>(`SELECT ${ROUTINE_COLUMNS} FROM routines WHERE id = ?`);
  const selectRoutineByName = db.query<RoutineRow, [string, string]>(
    `SELECT ${ROUTINE_COLUMNS} FROM routines WHERE tera_id = ? AND name = ?`,
  );
  const insertRoutine = db.query<unknown, [
    string,
    string,
    string,
    string,
    string,
    number,
    number | null,
    number | null,
    string | null,
    string | null,
    number,
    number,
  ]>(
    `INSERT INTO routines (${ROUTINE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 更新は、いまの行と突き合わせた完全な行をアプリ側で組み立ててから書く。
  const updateRoutineRow = db.query<unknown, [
    string,
    string,
    string,
    number,
    number | null,
    number | null,
    string | null,
    string | null,
    number,
    string,
  ]>(
    `UPDATE routines
        SET name = ?, prompt = ?, schedule = ?, enabled = ?, next_run_at = ?, last_run_at = ?,
            last_status = ?, last_detail = ?, updated_at = ?
      WHERE id = ?`,
  );
  const updateRoutineRun = db.query<unknown, [number, string, string | null, number | null, string]>(
    `UPDATE routines SET last_run_at = ?, last_status = ?, last_detail = ?, next_run_at = ? WHERE id = ?`,
  );
  const deleteRoutineById = db.query<unknown, [string]>("DELETE FROM routines WHERE id = ?");
  const selectDueRoutines = db.query<RoutineRow, [number]>(
    `SELECT ${ROUTINE_COLUMNS}
       FROM routines
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC, created_at ASC, rowid ASC`,
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
    deleteTera,
    selectMessagePage,
    selectMessagesSince,
    selectLastSeq,
    selectMessagesBetween,
    selectPendingStats,
    updateMessageParts,
    selectMessageById,
    deleteMessageById,
    insertMessage,
    selectRoutines,
    selectRoutinesOf,
    selectRoutineById,
    selectRoutineByName,
    insertRoutine,
    updateRoutineRow,
    updateRoutineRun,
    deleteRoutineById,
    selectDueRoutines,
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

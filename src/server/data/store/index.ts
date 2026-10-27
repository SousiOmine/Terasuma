import { Database } from "bun:sqlite";
import type { ChatMessage, MessagePart, Tera, TokenUsage } from "../../../shared/api/message";
import { nextRunAt as nextRunAtOfSchedule } from "../../routine/schedule";
import { migrateSchema } from "./migrations";
import { prepareQueries } from "./queries";
import { toMessage, toRoutine, toTera } from "./rows";
import { createSchema } from "./schema";
import {
  DEFAULT_TERA_ID,
  DEFAULT_TERA_IDENTITY,
  DEFAULT_TERA_NAME,
  type AppendMessageInput,
  type CreateRoutineInput,
  type CreateStoreOptions,
  type NewTera,
  type Store,
  type UpdateRoutineInput,
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
  CreateRoutineInput,
  CreateStoreOptions,
  MessageLog,
  MessagePageQuery,
  MessagePageResult,
  NewTera,
  PendingStats,
  RoutineRecord,
  RoutineStore,
  Store,
  TeraDirectory,
  TeraIdentity,
  TeraIdentityStore,
  UpdateRoutineInput,
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
      input.origin ?? null,
      at,
      input.usage?.inputTokens ?? null,
      input.usage?.outputTokens ?? null,
      input.usage?.cachedInputTokens ?? null,
    );
    // INSERT は RETURNING seq を必ず返す。返らなかったら、行が入っていないということなので、
    // それらしい連番を作って先へ進まない（壊れた行を画面とモデルの両方へ流さないため）。
    if (inserted === null) {
      throw new Error(`Could not append a message to Tera ${input.teraId} (seq was not returned)`);
    }
    const seq = inserted.seq;

    q.touchTera.run(at, input.teraId);

    return {
      id: input.id,
      teraId: input.teraId,
      seq,
      role: input.role,
      content: input.content,
      attachments,
      parts,
      origin: input.origin ?? null,
      createdAt: at,
      usage: input.usage ?? null,
    };
  });

  const updateParts = db.transaction(
    (id: string, input: { parts: readonly MessagePart[]; usage: TokenUsage | null }): ChatMessage | null => {
      q.updateMessageParts.run(
        JSON.stringify(input.parts),
        input.usage?.inputTokens ?? null,
        input.usage?.outputTokens ?? null,
        input.usage?.cachedInputTokens ?? null,
        id,
      );

      const row = q.selectMessageById.get(id);
      return row === null ? null : toMessage(row);
    },
  );

  // Tera の行と identity は、どちらも入るか、どちらも入らないか。
  // 行列だけが残ると、役割の無い Tera が画面に出てしまう。
  const createRoutine = db.transaction((input: CreateRoutineInput) => {
    // 同じ Tera の中で名前が重なると、一覧で区別できなくなる。
    if (q.selectRoutineByName.get(input.teraId, input.name) !== null) return null;

    const at = now();
    const id = crypto.randomUUID();
    // 有効なルーチンは、作った時点から次回時刻を持つ（作ったのに走らない、を防ぐ）。
    const next = input.enabled ? nextRunAtOfSchedule(input.schedule, at) : null;
    q.insertRoutine.run(
      id,
      input.teraId,
      input.name,
      input.prompt,
      JSON.stringify(input.schedule),
      input.enabled ? 1 : 0,
      next,
      null,
      null,
      null,
      at,
      at,
    );

    const row = q.selectRoutineById.get(id);
    return row === null ? null : toRoutine(row);
  });

  const updateRoutine = db.transaction((id: string, patch: UpdateRoutineInput) => {
    const row = q.selectRoutineById.get(id);
    if (row === null) return null;

    const current = toRoutine(row);
    const schedule = patch.schedule ?? current.schedule;
    const enabled = patch.enabled ?? current.enabled;
    const next = patch.nextRunAt === undefined ? current.nextRunAt : patch.nextRunAt;
    const at = now();

    q.updateRoutineRow.run(
      patch.name ?? current.name,
      patch.prompt ?? current.prompt,
      JSON.stringify(schedule),
      enabled ? 1 : 0,
      next,
      current.lastRunAt,
      current.lastStatus,
      current.lastDetail,
      at,
      id,
    );

    const updated = q.selectRoutineById.get(id);
    return updated === null ? null : toRoutine(updated);
  });

  const create = db.transaction((input: NewTera): Tera => {
    if (q.selectTera.get(input.id) !== null) {
      throw new Error(`同じ id の Tera が既にあります: ${input.id}`);
    }
    if (q.selectTeraByName.get(input.name) !== null) {
      throw new Error(`同じ名前の Tera が既にあります: ${input.name}`);
    }

    const at = now();
    q.insertTeraNew.run(input.id, input.name, at, at);
    // 新しい Tera は、書いた版と system プロンプト用の版が同じところから始まる。
    q.insertIdentity.run(input.id, input.identity, input.identity);

    const row = q.selectTera.get(input.id);
    if (row === null) throw new Error(`Tera を作成できなかった: ${input.id}`);
    return toTera(row);
  });

  const store: Store = {
    listTeras() {
      return q.selectTeras.all().map(toTera);
    },

    getTera(id) {
      const row = q.selectTera.get(id);
      return row === null ? null : toTera(row);
    },

    findTeraByName(name) {
      const row = q.selectTeraByName.get(name);
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

    createTera(input) {
      return create(input);
    },

    deleteTera(id) {
      // identity・要約・履歴は、外部キーの連鎖でこの 1 文と一緒に消える。
      return q.deleteTera.run(id).changes > 0;
    },

    ensureAtLeastOneTera() {
      // 既に 1 体でも居れば、名前も作成日時も変えない（起動のたびに呼ばれる）。
      if (store.listTeras().length > 0) return null;
      return store.ensureTera(DEFAULT_TERA_ID, DEFAULT_TERA_NAME);
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

    lastSeq(teraId) {
      // 集計は必ず 1 行返す。読めないのは保存先が壊れているときなので、黙って 0 にしない。
      const row = q.selectLastSeq.get(teraId);
      if (row === null) throw new Error(`最新の連番を読めませんでした: ${teraId}`);
      return row.seq;
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

    listRoutines() {
      return q.selectRoutines.all().map(toRoutine);
    },

    listRoutinesOf(teraId) {
      return q.selectRoutinesOf.all(teraId).map(toRoutine);
    },

    readRoutine(id) {
      const row = q.selectRoutineById.get(id);
      return row === null ? null : toRoutine(row);
    },

    createRoutine(input) {
      return createRoutine(input);
    },

    updateRoutine(id, patch) {
      return updateRoutine(id, patch);
    },

    deleteRoutine(id) {
      return q.deleteRoutineById.run(id).changes > 0;
    },

    recordRoutineRun(id, result) {
      q.updateRoutineRun.run(result.lastRunAt, result.lastStatus, result.lastDetail, result.nextRunAt, id);
    },

    dueRoutines(now) {
      return q.selectDueRoutines.all(now).map(toRoutine);
    },

    updateMessageParts(id, input) {
      return updateParts(id, input);
    },

    deleteMessage(id) {
      q.deleteMessageById.run(id);
    },

    readPendingStats(teraId, afterSeq) {
      const row = q.selectPendingStats.get(teraId, afterSeq);
      return {
        count: row?.count ?? 0,
        lastCreatedAt: row?.last_created_at ?? null,
        chars: row?.chars ?? 0,
      };
    },

    close() {
      db.close();
    },
  };

  // 会話の持ち主が 1 体も無いと何も始まらないので、1 体も無いときだけ既定の Tera を用意する。
  // 消した Tera は、再起動しても戻さない（戻すのは、最後の 1 体を消したその場だけ）。
  store.ensureAtLeastOneTera();
  return store;
}

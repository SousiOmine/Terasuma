import { describeError } from "../../shared/errors";
import type { ChatEvent } from "../../shared/api/message";
import type { RoutineStatus } from "../../shared/api/routine";
import type { ConversationBroadcast } from "../agent/broadcast";
import type { Turns } from "../agent/turns";
import type { RoutineRecord, RoutineStore } from "../data/store";
import type { SettingsStore } from "../data/settings";
import type { Catalog } from "../provider/catalog";
import { resolveModel } from "../provider/routing";
import { nextRunAt } from "./schedule";

/**
 * ルーチンを、サーバのローカル時刻で走らせる。
 *
 * 起動直後はコンテナやカタログの読み込みと重なるので、60 秒待ってから 1 回だけ追い実行する。
 * 落ちていた間の回はまとめない（1 回の tick で 1 回だけ走らせる）。
 * 重なったときは順番に走らせる（スキップしない）。
 * 走っているターンは止めない（止めるのは stop を呼んだときだけ）。
 */

/** タイマーの既定の間隔。 */
const DEFAULT_TICK_MS = 30_000;

/** 起動してから、落ちていた間の分を追い実行するまでの待ち。 */
const CATCH_UP_DELAY_MS = 60_000;

/** 枠が空くのを待つ間隔。 */
const SLOT_POLL_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RoutineScheduler = {
  /** タイマーを張る。起動 60 秒後に 1 回、そのあと 30 秒ごとに、走らせるべきものを走らせる。 */
  start(): void;
  /** タイマーを止める（走っているターンは止めない。停止は stop）。 */
  close(): void;
  /** いま 1 回走らせる（動作確認用）。次回時刻は動かさない。 */
  runNow(routineId: string): Promise<void>;
  /** そのルーチンが走っているか（順番待ちも含む）。 */
  isRunning(routineId: string): boolean;
  /** 走っているルーチン（順番待ちも含む）を止める。 */
  stop(routineId: string): void;
};

export function createRoutineScheduler(options: {
  store: RoutineStore;
  turns: Turns;
  broadcast: ConversationBroadcast;
  settings: SettingsStore;
  catalog: Catalog;
  /** 時刻（テストで差し替える）。 */
  now?: () => number;
  /** tick の間隔（テストで差し替える）。 */
  tickMs?: number;
  log?: (message: string) => void;
}): RoutineScheduler {
  const { store, turns, broadcast, settings, catalog } = options;
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const log = options.log ?? (() => undefined);

  /** 走っているルーチンと、その本数（順番待ちも含む）。 */
  const running = new Map<string, number>();
  /** stop で止めたルーチン。結果を "stopped" として書いたら消す。 */
  const stopped = new Set<string>();
  /** 順番待ちのうちに stop で止めたルーチン。走らせずに終える。 */
  const cancelled = new Set<string>();

  let catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    const at = now();
    for (const routine of store.dueRoutines(at)) {
      // 保存されたスケジュールが読めない行は、無効として返ってくる。走らせない。
      if (!routine.enabled) continue;

      // 実行より先に次回時刻を進める。実行が長引いても、次の tick で同じ回を二重に走らせない。
      const next = nextRunAt(routine.schedule, at);
      store.updateRoutine(routine.id, { nextRunAt: next });

      const advanced = store.readRoutine(routine.id) ?? { ...routine, nextRunAt: next };
      void run(advanced);
    }
  }

  async function run(routine: RoutineRecord): Promise<void> {
    const id = routine.id;
    running.set(id, (running.get(id) ?? 0) + 1);

    // 実行中に次回時刻が進んでいるので、結果を書くときは今の値を読む。
    const current = () => store.readRoutine(id) ?? routine;

    const record = (status: RoutineStatus, detail: string | null): void => {
      store.recordRoutineRun(id, {
        lastRunAt: now(),
        lastStatus: status,
        lastDetail: detail,
        nextRunAt: current().nextRunAt,
      });
    };

    try {
      const resolution = resolveModel(settings.read(), catalog.snapshot());
      if (!resolution.ok) {
        record("error", "モデルが設定されていません");
        log(`routine "${routine.name}" (Tera: ${routine.teraId}): error（モデル未設定）`);
        return;
      }

      // 1 Tera のターンは 1 本だけ。利用者のターンが走っていれば、終わるまで待ってから始める
      // （ルーチンをスキップしない）。待っている間に止められたら、走らせずに stopped で終える。
      let events: AsyncIterable<ChatEvent> | null = null;
      while (events === null) {
        if (cancelled.delete(id)) {
          record("stopped", null);
          log(`routine "${routine.name}" (Tera: ${routine.teraId}): stopped`);
          return;
        }
        // 待っている間に Tera ごと消えたら、走らせない（保存先も無い）。
        if (store.readRoutine(id) === null) return;
        if (turns.hasTurn(routine.teraId)) {
          await delay(SLOT_POLL_MS);
          continue;
        }
        events = turns.begin(
          routine.teraId,
          // ルーチンには利用者の言語設定が無いので、既定の日本語で返す。
          { content: routine.prompt, attachments: null, language: "ja" },
          { origin: { kind: "routine", routineId: id, routineName: routine.name } },
        );
        if (events === null) await delay(SLOT_POLL_MS);
      }

      // 配るのは relay の仕事。ここでは最後まで読んで、失敗の理由だけを拾う。
      let failure: string | null = null;
      for await (const event of broadcast.relay(routine.teraId, events, "")) {
        if (event.type === "error") failure = event.detail;
      }

      const status: RoutineStatus = stopped.has(id) ? "stopped" : failure !== null ? "error" : "ok";
      record(status, status === "error" ? failure : null);
      log(`routine "${routine.name}" (Tera: ${routine.teraId}): ${status}`);
    } catch (error) {
      const status: RoutineStatus = stopped.has(id) ? "stopped" : "error";
      record(status, status === "error" ? describeError(error) : null);
      log(`routine "${routine.name}" (Tera: ${routine.teraId}): ${status}（${describeError(error)}）`);
    } finally {
      const left = (running.get(id) ?? 1) - 1;
      if (left > 0) running.set(id, left);
      else {
        running.delete(id);
        // 走っている回が無くなったら、停止の印も片付ける（次の回を止め扱いにしない）。
        stopped.delete(id);
        cancelled.delete(id);
      }
    }
  }

  return {
    start() {
      if (catchUpTimer !== null || tickTimer !== null) return;

      // テストで tickMs を縮めたときは、その間隔で最初の 1 回を起こす。
      // 本番（既定の 30 秒）では、起動直後の読み込みと重ならないよう 60 秒待つ。
      const firstDelay = tickMs === DEFAULT_TICK_MS ? CATCH_UP_DELAY_MS : tickMs;
      catchUpTimer = setTimeout(() => {
        catchUpTimer = null;
        tick();
        tickTimer = setInterval(tick, tickMs);
      }, firstDelay);
    },

    close() {
      if (catchUpTimer !== null) {
        clearTimeout(catchUpTimer);
        catchUpTimer = null;
      }
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    },

    async runNow(routineId) {
      const routine = store.readRoutine(routineId);
      if (routine === null) return;
      await run(routine);
    },

    isRunning(routineId) {
      return (running.get(routineId) ?? 0) > 0;
    },

    stop(routineId) {
      const routine = store.readRoutine(routineId);
      if (routine === null) return;

      const origin = turns.runningOrigin(routine.teraId);
      const isRunningNow = origin !== null && origin.kind === "routine" && origin.routineId === routineId;

      if (isRunningNow) {
        // 走っている。止めたことを覚えてから、ターンを止める（結果は stopped で書く）。
        stopped.add(routineId);
        turns.stop(routine.teraId);
        return;
      }

      // 順番待ちのうちに止められた。走らせずに終える。
      if (running.has(routineId)) cancelled.add(routineId);
    },
  };
}

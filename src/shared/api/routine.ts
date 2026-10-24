/**
 * ルーチン（Tera が決まった時刻に、決まった指示で自分から走らせるターン）の型。
 * 保存層・スケジューラ・画面・API で共有する。
 */

/** ルーチンの実行時刻の決め方。曜日は 1=月 … 7=日。時刻はサーバのローカル時刻。 */
export type RoutineSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "every"; minutes: number };

/** 最後の実行の結果。running は「いま走っている」。 */
export type RoutineStatus = "running" | "ok" | "error" | "stopped";

/** 設定画面と API が返すルーチン 1 件。 */
export type RoutineView = {
  id: string;
  teraId: string;
  teraName: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  /** 次に走る時刻（ms）。無効なら null。 */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: RoutineStatus | null;
  /** 失敗した理由。無ければ null。 */
  lastDetail: string | null;
  /** いま走っているか（メモリ上の状態。保存はしない）。 */
  running: boolean;
};

export type RoutinesView = { routines: RoutineView[] };

/** 上限と既定値。画面とツールの説明が同じ数字を使えるようにここへ置く。 */
export const ROUTINE_NAME_MAX_CHARS = 60;
export const ROUTINE_PROMPT_MAX_CHARS = 4_000;
export const ROUTINES_PER_TERA_MAX = 50;
export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 1_440;

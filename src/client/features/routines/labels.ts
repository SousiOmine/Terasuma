import type { RoutineSchedule, RoutineStatus } from "../../../shared/api/routine";
import { t, type MessageKey } from "../../i18n";
import { localeTag } from "../chat/timeline";

/**
 * ルーチンの表示文言。
 *
 * スケジュール・最後の結果・次回の時刻を、画面とテストで同じ形にする。
 * ここは DOM を触らない純粋な関数だけを置く。
 */

/** 曜日は 1=月 … 7=日。文字列は辞書から引く。 */
const WEEKDAY_KEYS: readonly MessageKey[] = [
  "routine.weekday.1",
  "routine.weekday.2",
  "routine.weekday.3",
  "routine.weekday.4",
  "routine.weekday.5",
  "routine.weekday.6",
  "routine.weekday.7",
];

const STATUS_KEYS: Record<RoutineStatus, MessageKey> = {
  ok: "routine.status.ok",
  error: "routine.status.error",
  stopped: "routine.status.stopped",
  running: "routine.status.running",
};

/** スケジュールを 1 行にする（例: "毎日 08:30" / "毎週 月・水 18:00" / "30 分ごと"）。 */
export function scheduleLabel(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return t("routine.schedule.daily", { time: schedule.time });
    case "weekly": {
      const days = schedule.days
        .map((day) => WEEKDAY_KEYS[day - 1])
        .filter((key): key is MessageKey => key !== undefined)
        .map((key) => t(key))
        .join("・");
      return t("routine.schedule.weekly", { days, time: schedule.time });
    }
    case "every":
      return t("routine.schedule.every", { minutes: schedule.minutes });
  }
}

/** 最後の結果の文言（例: "成功" "失敗" "停止" "実行中"）。null は空文字。 */
export function statusLabel(status: RoutineStatus | null): string {
  return status === null ? "" : t(STATUS_KEYS[status]);
}

/** 次回の時刻（例: "10/25 08:30"）。null は空文字。 */
export function nextRunLabel(at: number | null): string {
  if (at === null) return "";

  return new Intl.DateTimeFormat(localeTag(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

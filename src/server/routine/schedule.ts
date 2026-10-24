import { isRecord } from "../../shared/guards";
import {
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
  type RoutineSchedule,
} from "../../shared/api/routine";

/**
 * ルーチンの実行時刻。
 *
 * 保存されている値の読み戻しと、画面・API からの入力の検証、次回時刻の計算だけを持つ。
 * now を引数で受けるので、テストでは時計を進めずに境界を確かめられる。
 */

/** HH:MM（00:00〜23:59）。 */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 保存された値（JSON）を RoutineSchedule にする。形が違えば null。 */
export function parseSchedule(value: unknown): RoutineSchedule | null {
  if (scheduleProblem(value) !== null) return null;

  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "daily":
      return { kind: "daily", time: record.time as string };
    case "weekly":
      return { kind: "weekly", days: [...(record.days as number[])], time: record.time as string };
    case "every":
      return { kind: "every", minutes: record.minutes as number };
    default:
      // scheduleProblem が通した値なので、ここへは来ない。
      return null;
  }
}

/** 画面と API の入力を検証する。受け付けられない理由を返す（使えるなら null）。 */
export function scheduleProblem(value: unknown): string | null {
  if (!isRecord(value)) return "schedule はオブジェクトで指定してください";

  switch (value.kind) {
    case "daily":
      return TIME_PATTERN.test(String(value.time)) ? null : timeProblem();
    case "weekly": {
      if (!TIME_PATTERN.test(String(value.time))) return timeProblem();
      return daysProblem(value.days);
    }
    case "every":
      return minutesProblem(value.minutes);
    default:
      return `知らないスケジュールの種類です: ${String(value.kind)}`;
  }
}

/** from より後に来る、最初の実行時刻（ms）。ローカル時刻で計算する。 */
export function nextRunAt(schedule: RoutineSchedule, from: number): number {
  switch (schedule.kind) {
    case "daily": {
      const [hours, minutes] = timeParts(schedule.time);
      const date = new Date(from);
      date.setHours(hours, minutes, 0, 0);
      // ちょうど同じ時刻は「もう過ぎた」とみなす（同じ回を二重に走らせない）。
      if (date.getTime() <= from) {
        date.setDate(date.getDate() + 1);
        date.setHours(hours, minutes, 0, 0);
      }
      return date.getTime();
    }
    case "weekly": {
      const [hours, minutes] = timeParts(schedule.time);
      // 今日から 7 日先まで見る。今日しか当てはまらない場合の翌週も含めるため、7 日目まで見る。
      for (let offset = 0; offset <= 7; offset += 1) {
        const date = new Date(from);
        date.setDate(date.getDate() + offset);
        date.setHours(hours, minutes, 0, 0);
        if (date.getTime() <= from) continue;
        if (schedule.days.includes(weekdayOf(date))) return date.getTime();
      }
      // days は 1 つ以上あるので、ここへは来ない。
      throw new Error("次の実行時刻を決められませんでした");
    }
    case "every":
      return from + schedule.minutes * 60_000;
  }
}

/** 曜日を 1=月 … 7=日で返す（Date は 0=日 … 6=土）。 */
function weekdayOf(date: Date): number {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

/** "HH:MM" を時と分に分ける。検証済みの値だけが来る。 */
function timeParts(time: string): [hours: number, minutes: number] {
  const [hours, minutes] = time.split(":");
  return [Number(hours), Number(minutes)];
}

function timeProblem(): string {
  return "時刻は HH:MM（00:00〜23:59）で指定してください";
}

function daysProblem(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return "曜日は 1（月）から 7（日）の重複しない配列で 1 つ以上指定してください";
  }

  const seen = new Set<number>();
  for (const day of value) {
    if (!Number.isInteger(day) || day < 1 || day > 7 || seen.has(day)) {
      return "曜日は 1（月）から 7（日）の重複しない配列で 1 つ以上指定してください";
    }
    seen.add(day);
  }
  return null;
}

function minutesProblem(value: unknown): string | null {
  if (!Number.isInteger(value) || (value as number) < MIN_EVERY_MINUTES || (value as number) > MAX_EVERY_MINUTES) {
    return `間隔は ${MIN_EVERY_MINUTES} 分から ${MAX_EVERY_MINUTES} 分の整数で指定してください`;
  }
  return null;
}

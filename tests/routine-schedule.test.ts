import { describe, expect, test } from "bun:test";
import type { RoutineSchedule } from "../src/shared/api/routine";
import { nextRunAt, parseSchedule, scheduleProblem } from "../src/server/routine/schedule";

/** ローカル時刻で Date を作る（タイムゾーンはサーバのローカル時刻に合わせる）。 */
function at(year: number, month: number, day: number, hours: number, minutes: number): number {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

describe("次の実行時刻", () => {
  test("毎日: 今日の時刻がまだ来ていなければ今日、過ぎていれば翌日", () => {
    const schedule = { kind: "daily", time: "09:30" } as const;

    expect(nextRunAt(schedule, at(2024, 1, 1, 8, 0))).toBe(at(2024, 1, 1, 9, 30));
    expect(nextRunAt(schedule, at(2024, 1, 1, 10, 0))).toBe(at(2024, 1, 2, 9, 30));
  });

  test("毎日: ちょうど同じ時刻なら、翌日の同じ時刻", () => {
    const schedule = { kind: "daily", time: "09:30" } as const;

    expect(nextRunAt(schedule, at(2024, 1, 1, 9, 30))).toBe(at(2024, 1, 2, 9, 30));
  });

  test("毎週: 今日から順に見て、最初に当てはまる曜日と時刻", () => {
    // 2024-01-01 は月曜日。
    const schedule: RoutineSchedule = { kind: "weekly", days: [3], time: "12:00" };

    expect(nextRunAt(schedule, at(2024, 1, 1, 10, 0))).toBe(at(2024, 1, 3, 12, 0));
    expect(nextRunAt(schedule, at(2024, 1, 1, 13, 0))).toBe(at(2024, 1, 3, 12, 0));
  });

  test("毎週: 今日しか当てはまらないときは、翌週の同じ曜日", () => {
    const schedule: RoutineSchedule = { kind: "weekly", days: [1], time: "09:00" };

    expect(nextRunAt(schedule, at(2024, 1, 1, 10, 0))).toBe(at(2024, 1, 8, 9, 0));
  });

  test("N 分ごと: from から N 分後", () => {
    const schedule = { kind: "every", minutes: 5 } as const;

    expect(nextRunAt(schedule, at(2024, 1, 1, 9, 0))).toBe(at(2024, 1, 1, 9, 5));
  });
});

describe("スケジュールの検証", () => {
  test("受け付けられない値を断る", () => {
    expect(scheduleProblem({ kind: "daily", time: "99:99" })).not.toBeNull();
    expect(scheduleProblem({ kind: "weekly", days: [], time: "09:00" })).not.toBeNull();
    expect(scheduleProblem({ kind: "weekly", days: [1, 1], time: "09:00" })).not.toBeNull();
    expect(scheduleProblem({ kind: "every", minutes: 4 })).not.toBeNull();
    expect(scheduleProblem({ kind: "every", minutes: 1_441 })).not.toBeNull();
    expect(scheduleProblem({ kind: "monthly", time: "09:00" })).not.toBeNull();
    expect(scheduleProblem(null)).not.toBeNull();
  });

  test("使える値は理由を返さない", () => {
    expect(scheduleProblem({ kind: "daily", time: "00:00" })).toBeNull();
    expect(scheduleProblem({ kind: "weekly", days: [1, 7], time: "23:59" })).toBeNull();
    expect(scheduleProblem({ kind: "every", minutes: 5 })).toBeNull();
    expect(scheduleProblem({ kind: "every", minutes: 1_440 })).toBeNull();
  });

  test("parseSchedule は使える値だけを返す", () => {
    expect(parseSchedule({ kind: "daily", time: "09:00" })).toEqual({ kind: "daily", time: "09:00" });
    expect(parseSchedule({ kind: "weekly", days: [2, 4], time: "10:00" })).toEqual({
      kind: "weekly",
      days: [2, 4],
      time: "10:00",
    });
    expect(parseSchedule({ kind: "every", minutes: 15 })).toEqual({ kind: "every", minutes: 15 });
    expect(parseSchedule({ kind: "daily", time: "9:00" })).toBeNull();
    expect(parseSchedule({ kind: "every", minutes: 4 })).toBeNull();
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import type { RoutineSchedule } from "../../src/shared/api/routine";
import { setLocale } from "../../src/client/i18n";
import { nextRunLabel, scheduleLabel, statusLabel } from "../../src/client/features/routines/labels";

const AT = new Date(2026, 9, 25, 8, 30).getTime();

afterAll(() => {
  setLocale("ja");
});

describe("ルーチンの表示文言", () => {
  test("毎日のスケジュールを、日本語と英語で表す", () => {
    const schedule: RoutineSchedule = { kind: "daily", time: "08:30" };

    setLocale("ja");
    expect(scheduleLabel(schedule)).toBe("毎日 08:30");

    setLocale("en");
    expect(scheduleLabel(schedule)).toBe("Every day at 08:30");
  });

  test("毎週のスケジュールは、曜日を・でつなぐ", () => {
    const schedule: RoutineSchedule = { kind: "weekly", days: [1, 3], time: "18:00" };

    setLocale("ja");
    expect(scheduleLabel(schedule)).toBe("毎週 月・水 18:00");

    setLocale("en");
    expect(scheduleLabel(schedule)).toBe("Every Mon・Wed at 18:00");
  });

  test("N 分ごとのスケジュールを、日本語と英語で表す", () => {
    const schedule: RoutineSchedule = { kind: "every", minutes: 30 };

    setLocale("ja");
    expect(scheduleLabel(schedule)).toBe("30 分ごと");

    setLocale("en");
    expect(scheduleLabel(schedule)).toBe("Every 30 min");
  });

  test("最後の結果を文言にし、null は空文字にする", () => {
    setLocale("ja");
    expect(statusLabel("ok")).toBe("成功");
    expect(statusLabel("error")).toBe("失敗");
    expect(statusLabel("stopped")).toBe("停止");
    expect(statusLabel("running")).toBe("実行中");
    expect(statusLabel(null)).toBe("");

    setLocale("en");
    expect(statusLabel("ok")).toBe("Succeeded");
    expect(statusLabel("error")).toBe("Failed");
    expect(statusLabel("stopped")).toBe("Stopped");
    expect(statusLabel("running")).toBe("Running");
    expect(statusLabel(null)).toBe("");
  });

  test("次回の時刻をローカル時刻で表し、null は空文字にする", () => {
    setLocale("ja");
    expect(nextRunLabel(AT)).toBe(
      new Intl.DateTimeFormat("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(AT),
    );
    expect(nextRunLabel(null)).toBe("");

    setLocale("en");
    expect(nextRunLabel(AT)).toBe(
      new Intl.DateTimeFormat("en-US", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(AT),
    );
    expect(nextRunLabel(null)).toBe("");
  });
});

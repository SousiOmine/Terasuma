import { describe, expect, test } from "bun:test";
import { isRecord, recordOf } from "../src/shared/guards";
import { formatBytes, formatLocalDate, truncateText } from "../src/shared/text";

describe("値の形", () => {
  test("オブジェクトだけを受け付け、配列と null は断る", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(recordOf({ a: 1 })).toEqual({ a: 1 });
    expect(recordOf([])).toBeNull();
  });
});

describe("文字列の整形", () => {
  test("短ければそのまま返す", () => {
    expect(truncateText("abc", 10, "brackets")).toBe("abc");
    expect(truncateText("abc", 3, "marked")).toBe("abc");
  });

  test("切り詰めの書式を選べる", () => {
    expect(truncateText("abcdef", 3, "brackets")).toBe("abc\n[... 3 more characters truncated]");
    expect(truncateText("abcdef", 3, "parens")).toBe("abc\n… (3 more characters)");
    expect(truncateText("abcdef", 3, "marked")).toBe("abc… (truncated)");
  });

  test("バイト数は空白の有無を選べる", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(1536, { space: false })).toBe("1.5KB");
  });

  test("ローカル日付は端末の時刻で組み立てる", () => {
    const at = new Date(2026, 0, 2, 3, 4).getTime();

    expect(formatLocalDate(at)).toBe("2026-01-02");
    expect(formatLocalDate(at, { time: true })).toBe("2026-01-02 03:04");
  });
});

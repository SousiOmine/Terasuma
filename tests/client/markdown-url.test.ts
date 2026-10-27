import { describe, expect, test } from "bun:test";
import { safeHref } from "../../src/client/features/chat/markdown/url";

/**
 * 本文の URL をリンクにしてよいかの判定。
 * ここを通らなかった URL は、文字として出す（押しても何も起きない）。
 */
describe("リンクにしてよい URL", () => {
  test("http と https は通す", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHref("http://example.com")).toBe("http://example.com");
  });

  test("mailto と、このアプリの中のパスは通す", () => {
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeHref("/api/files/abc")).toBe("/api/files/abc");
  });

  test("javascript と data はリンクにしない", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  test("プロトコル相対と空文字はリンクにしない", () => {
    expect(safeHref("//example.com")).toBeNull();
    expect(safeHref("   ")).toBeNull();
  });

  test("前後の空白は落としてから見る", () => {
    expect(safeHref("  https://example.com  ")).toBe("https://example.com");
  });
});

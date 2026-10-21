import { describe, expect, test } from "bun:test";
import { isSendKey, type SendKeyEvent } from "../src/client/lib/composer-keys";

/** 押されたキーの組み合わせを作る。既定は Enter 単独。 */
function press(overrides: Partial<SendKeyEvent>): SendKeyEvent {
  return { key: "Enter", shiftKey: false, isComposing: false, ...overrides };
}

describe("送信のキー操作", () => {
  test("Enter は送信する", () => {
    expect(isSendKey(press({}))).toBe(true);
  });

  test("Shift + Enter は送信しない（改行に使う）", () => {
    expect(isSendKey(press({ shiftKey: true }))).toBe(false);
  });

  test("日本語入力の変換確定の Enter は送信しない", () => {
    expect(isSendKey(press({ isComposing: true }))).toBe(false);
    expect(isSendKey(press({ shiftKey: true, isComposing: true }))).toBe(false);
  });

  test("Enter 以外のキーは送信しない", () => {
    expect(isSendKey(press({ key: "a" }))).toBe(false);
    expect(isSendKey(press({ key: "Escape" }))).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { isSendKey, type SendKeyEvent } from "../src/client/lib/composer-keys";

/** 押されたキーの組み合わせを作る。既定は Enter 単独（改行）。 */
function press(overrides: Partial<SendKeyEvent>): SendKeyEvent {
  return { key: "Enter", shiftKey: false, ctrlKey: false, isComposing: false, ...overrides };
}

describe("送信のキー操作", () => {
  test("Ctrl + Enter は送信する", () => {
    expect(isSendKey(press({ ctrlKey: true }))).toBe(true);
  });

  test("Enter は送信しない（改行）", () => {
    expect(isSendKey(press({}))).toBe(false);
    expect(isSendKey(press({ shiftKey: true }))).toBe(false);
  });

  test("Ctrl + 日本語入力の変換確定の Enter は送信しない", () => {
    expect(isSendKey(press({ ctrlKey: true, isComposing: true }))).toBe(false);
  });

  test("Enter 以外のキーは送信しない", () => {
    expect(isSendKey(press({ key: "a", ctrlKey: true }))).toBe(false);
    expect(isSendKey(press({ key: "Escape", ctrlKey: true }))).toBe(false);
  });
});

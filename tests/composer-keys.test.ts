import { describe, expect, test } from "bun:test";
import { isSendKey, type SendKeyEvent } from "../src/client/composerKeys";

/** 押されたキーの組み合わせを作る。既定は Enter 単独。 */
function press(overrides: Partial<SendKeyEvent>): SendKeyEvent {
  return { key: "Enter", ctrlKey: false, metaKey: false, isComposing: false, ...overrides };
}

describe("送信のキー操作", () => {
  test("Ctrl + Enter は送信する", () => {
    expect(isSendKey(press({ ctrlKey: true }))).toBe(true);
  });

  test("Cmd + Enter も送信する", () => {
    expect(isSendKey(press({ metaKey: true }))).toBe(true);
  });

  test("Enter は送信しない（改行に使う）", () => {
    expect(isSendKey(press({}))).toBe(false);
  });

  test("日本語入力の変換確定の Enter は送信しない", () => {
    expect(isSendKey(press({ ctrlKey: true, isComposing: true }))).toBe(false);
    expect(isSendKey(press({ isComposing: true }))).toBe(false);
  });

  test("Enter 以外のキーは、修飾キーが押されていても送信しない", () => {
    expect(isSendKey(press({ key: "a", ctrlKey: true }))).toBe(false);
    expect(isSendKey(press({ key: "Escape" }))).toBe(false);
  });
});

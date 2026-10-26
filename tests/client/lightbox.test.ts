import { describe, expect, test } from "bun:test";
import { stepImageIndex } from "../../src/client/features/chat/lightbox";

/**
 * 拡大表示で、複数の画像を前後に送る番号。
 * 端では反対の端へ回り、画像が無いときも落ちない。
 */

describe("画像の番号を送る", () => {
  test("1 進む / 1 戻る", () => {
    expect(stepImageIndex(0, 3, 1)).toBe(1);
    expect(stepImageIndex(2, 3, -1)).toBe(1);
  });

  test("端で回る", () => {
    expect(stepImageIndex(0, 3, -1)).toBe(2);
    expect(stepImageIndex(2, 3, 1)).toBe(0);
  });

  test("画像 1 枚なら常に 0", () => {
    expect(stepImageIndex(0, 1, 1)).toBe(0);
    expect(stepImageIndex(0, 1, -1)).toBe(0);
    expect(stepImageIndex(1, 1, 1)).toBe(0);
  });

  test("画像が 0 枚でも落ちず 0", () => {
    expect(stepImageIndex(0, 0, 1)).toBe(0);
    expect(stepImageIndex(3, 0, -1)).toBe(0);
  });

  test("大きく飛んでも 0..count-1 に収まる", () => {
    expect(stepImageIndex(0, 3, 5)).toBe(2);
    expect(stepImageIndex(0, 3, -5)).toBe(1);
    expect(stepImageIndex(7, 4, 9)).toBe(0);
  });
});

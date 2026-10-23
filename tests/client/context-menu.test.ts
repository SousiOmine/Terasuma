import { describe, expect, test } from "bun:test";
import { fitMenuPosition } from "../../src/client/lib/context-menu";

/**
 * 右クリックで出すメニューの位置。
 * DOM を使わず、はみ出しの寄せ方だけを確かめる。
 */

const MENU = { width: 176, height: 44 };
const VIEWPORT = { width: 800, height: 600 };

describe("右クリックのメニューの位置", () => {
  test("画面に収まるときは、そのままの位置に出す", () => {
    expect(fitMenuPosition({ x: 100, y: 120 }, MENU, VIEWPORT)).toEqual({ x: 100, y: 120 });
  });

  test("右端・下端に近いときは、はみ出さない位置へ寄せる", () => {
    expect(fitMenuPosition({ x: 790, y: 590 }, MENU, VIEWPORT)).toEqual({
      x: VIEWPORT.width - MENU.width - 8,
      y: VIEWPORT.height - MENU.height - 8,
    });
  });

  test("左上に寄りすぎても、端の余白は空ける", () => {
    expect(fitMenuPosition({ x: 0, y: 0 }, MENU, VIEWPORT)).toEqual({ x: 8, y: 8 });
  });

  test("メニューが画面より大きいときは、左上の余白を優先する", () => {
    expect(fitMenuPosition({ x: 100, y: 100 }, { width: 900, height: 700 }, VIEWPORT)).toEqual({ x: 8, y: 8 });
  });
});

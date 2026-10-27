/**
 * 数値の扱い。上限と下限に収める計算を、各所に書き写さない。
 */

/**
 * 整数に丸めて、下限と上限の間に収める。
 * モデルや画面から来た件数・文字数の上限は、ここを通してから使う。
 */
export function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * 文字列の小さな整形。
 * 画面の入力と設定ファイルの検証で同じ扱いにするため、ここに置く。
 */

/** 前後の空白を落とし、空になったら null にする（未入力と同じ意味にする）。 */
export function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

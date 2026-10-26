/** 複数の画像を送るときの番号。端まで行ったら反対の端へ回る。 */
export function stepImageIndex(index: number, count: number, delta: number): number {
  const size = Math.trunc(count);
  if (size <= 0) return 0;

  const shifted = Math.trunc(index) + Math.trunc(delta);
  return ((shifted % size) + size) % size;
}

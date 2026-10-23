/** 画面の左上からの位置（px）。 */
export type MenuPoint = {
  x: number;
  y: number;
};

/** 要素の大きさ（px）。 */
export type MenuSize = {
  width: number;
  height: number;
};

/** メニューを画面の端から離しておく余白（px）。 */
const EDGE_MARGIN = 8;

/**
 * 右クリックした位置に出すメニューを、画面からはみ出さない位置へ寄せる。
 *
 * 右端・下端に近いときは、内側へずらして全部が見えるようにする。
 * メニューが画面より大きいときは、左上の余白を優先する（その端では切れる）。
 */
export function fitMenuPosition(point: MenuPoint, size: MenuSize, viewport: MenuSize): MenuPoint {
  const maxX = viewport.width - size.width - EDGE_MARGIN;
  const maxY = viewport.height - size.height - EDGE_MARGIN;

  return {
    x: Math.max(EDGE_MARGIN, Math.min(point.x, maxX)),
    y: Math.max(EDGE_MARGIN, Math.min(point.y, maxY)),
  };
}

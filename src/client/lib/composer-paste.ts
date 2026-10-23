/**
 * 貼り付け（Ctrl+V）で渡されたファイルの取り出し。
 * Composer から切り出して、ブラウザを介さずにテストできるようにしてある。
 *
 * クリップボードの画像やファイルは、ブラウザによって files（DataTransfer.files）と
 * items（DataTransfer.items）のどちらかに現れる。両方に同じものが入っていることもあるので、
 * files があればそれだけを使い、無いときだけ items から拾って二重に数えない。
 */

/** 貼り付けの項目のうち、こちらが読む部分。DataTransferItem と同じ形。 */
export type PastedItem = {
  kind: string;
  getAsFile(): File | null;
};

/** 貼り付けた内容から、添付に回すファイルを順番どおりに取り出す。 */
export function pastedFiles(files: readonly File[], items: readonly PastedItem[]): File[] {
  if (files.length > 0) return [...files];

  const found: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) found.push(file);
  }
  return found;
}

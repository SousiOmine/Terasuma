/**
 * 文字列の小さな処理。取り込む依存を増やさないため、必要なものだけをここに置く。
 */

/**
 * 本文を上限までに切る。
 * 切ったことを本文に残す（全文だと思って読ませない）。
 */
export function truncateText(text: string, maxChars: number): string {
  const limit = Math.max(1, Math.trunc(maxChars));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n… (${text.length - limit} more characters)`;
}

/**
 * チャットに添付できるファイルの上限。
 *
 * 画面とサーバの両方が同じ値で確かめる。片方だけ変えると、
 * 画面では通ったのに送信で弾かれる（またはその逆）状態になるため、ここに 1 つだけ置く。
 *
 * 上限は、送信本文をメモリに読み込んでコンテナへ書く今の作りに合わせている。
 * 大きなファイルは、ホストの共有フォルダ（container/home）へ直接置いてもらう。
 */

/** 1 メッセージに添付できるファイルの数。 */
export const MAX_ATTACHMENTS = 10;

/** 1 ファイルの上限。 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** 1 メッセージの合計の上限。 */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 50 * 1024 * 1024;

/** 画面とエラー本文に出す、読みやすい大きさ。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

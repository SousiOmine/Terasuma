/**
 * 中断の確認と、待ち時間の合成。
 *
 * ツールはコンテナのコマンドを待つ間に、ターンが止まっていないかを確かめる。
 * タイムアウトと利用者・呼び出し元の中断を 1 つの signal にまとめる形も、
 * HTTP だけでなくコマンドの実行でも使うので、ここに置く。
 */

/** ターンが止まっていれば中断する。理由の文言はここで 1 つに決める。 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("Operation aborted because the turn stopped");
}

/** タイムアウトと、呼び出し元の中断を 1 つの signal にまとめる。 */
export function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * 中断の確認。
 *
 * ツールはコンテナのコマンドを待つ間に、ターンが止まっていないかを確かめる。
 * 同じ 1 行を各ツールに書き写さず、理由の文言も 1 か所で決める。
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("Operation aborted because the turn stopped");
}

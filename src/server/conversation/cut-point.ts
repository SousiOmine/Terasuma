import type { ChatMessage } from "../../shared/api/message";
import { estimateMessageTokens } from "./tokens";

/**
 * 履歴を畳むときの切れ目。
 *
 * 「直近をどれだけ生のまま残すか」と「どこから古い方を畳むか」を決める。
 * 履歴の配列だけを見る純粋な関数なので、ターンの実行や保存を通さずに試せる。
 * ターンの途中で切るときは、そのターンの user 発言まで遡って前半を別に畳む
 * （前半と後半で文脈が途切れないようにするため）。
 */

export type CutPoint = {
  /** ここから先を生のまま残す。 */
  firstKept: number;
  /** ターンの途中で切るとき、そのターンの user 発言の位置。切らないときは -1。 */
  turnStart: number;
  isSplitTurn: boolean;
};

/**
 * 直近を生のまま残す切れ目を探す。
 * 新しい方からトークンを足していき、keepRecentTokens に届いた位置で切る。
 *
 * 切れ目がターンの途中（assistant）なら、そのターンの user 発言まで遡り、
 * ターンの前半を「ターン前半」として別に要約する（pi の split turn と同じ扱い）。
 */
export function findCutPoint(messages: readonly ChatMessage[], keepRecentTokens: number): CutPoint {
  let accumulated = 0;
  let cut = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) break;

    accumulated += estimateMessageTokens(message);
    if (accumulated >= keepRecentTokens) {
      cut = index;
      break;
    }
  }

  // 直近だけで予算に届かない。畳むものが無い。
  if (cut === -1) return { firstKept: 0, turnStart: -1, isSplitTurn: false };

  const entry = messages[cut];
  if (entry === undefined) return { firstKept: 0, turnStart: -1, isSplitTurn: false };
  if (entry.role === "user") return { firstKept: cut, turnStart: -1, isSplitTurn: false };

  const turnStart = findTurnStart(messages, cut);
  return { firstKept: cut, turnStart, isSplitTurn: turnStart !== -1 };
}

/** その位置を含むターンの user 発言を、古い方へ探す。見つからなければ -1。 */
function findTurnStart(messages: readonly ChatMessage[], index: number): number {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.role === "user") return cursor;
  }
  return -1;
}

/** 古い方から、1 回に載せる量に収まる範囲を切り出す。1 件で超えるものは、その 1 件だけを返す。 */
export function takeChunk(messages: readonly ChatMessage[], maxTokens: number): ChatMessage[] {
  const chunk: ChatMessage[] = [];
  let used = 0;

  for (const message of messages) {
    const size = estimateMessageTokens(message);
    if (chunk.length > 0 && used + size > maxTokens) break;
    chunk.push(message);
    used += size;
  }
  return chunk;
}

import type { ChatMessageView, MessagePage } from "../../shared/api/message";

/**
 * 履歴の重ね合わせ。
 *
 * 画面は、送信の応答・購読・履歴の読み直しから、同じ発言を何度も受け取る。
 * 並びは seq（Tera の中の連番）で決まるので、同じ id は重ねて 1 つにし、seq の順に置く。
 */

/**
 * まだ保存された連番が分からない発言の seq。
 * 送信の応答が途中で切れたとき、読み直すまでの間だけ、そのターンの内容をこの seq で置いておく。
 */
export const UNSAVED_SEQ = 0;

/** 保存済みの発言を重ねる。同じ id は、あとから来た内容で置き換える。 */
export function mergeSaved(
  current: readonly ChatMessageView[],
  incoming: readonly ChatMessageView[],
): ChatMessageView[] {
  const incomingIds = new Set(incoming.map((message) => message.id));
  const merged = current.filter((message) => !incomingIds.has(message.id));

  for (const message of incoming) {
    const index = merged.findIndex((entry) => sortKey(entry) > sortKey(message));
    if (index === -1) merged.push(message);
    else merged.splice(index, 0, message);
  }
  return merged;
}

/** 保存されている最新の seq。仮置き（seq 0）は数えない。まだ 1 件も無ければ 0。 */
export function newestSavedSeq(messages: readonly ChatMessageView[]): number {
  let newest = 0;
  for (const message of messages) {
    if (message.seq > newest) newest = message.seq;
  }
  return newest;
}

/** 最新のページを重ねた結果。 */
export type LatestPage = {
  messages: ChatMessageView[];
  /**
   * 古い側の情報（どこまで読んだか・さらに前があるか）を作り直す必要があるか。
   * 履歴を捨てて最新から読み直したときと、まだ何も持っていなかったとき。
   */
  resetOlder: boolean;
};

/**
 * 保存されている最新のページを、いま持っている履歴へ重ねる。
 *
 * 欠けている発言が 1 ページに収まらないときは、いまの履歴を捨てて最新から読み直す
 * （読んでいた位置は失うが、途中の抜けた履歴を見せるよりよい）。
 */
export function mergeLatestPage(current: readonly ChatMessageView[], page: MessagePage): LatestPage {
  const newest = page.messages.at(-1)?.seq ?? 0;

  if (newest - newestSavedSeq(current) > page.messages.length) {
    return { messages: page.messages, resetOlder: true };
  }

  // 何も持っていなかったときは、重ねた結果がそのまま最新のページになる。
  return { messages: mergeSaved(current, page.messages), resetOlder: current.length === 0 };
}

/** 並べ替えの基準。仮置き（seq 0）は、保存済みのどの発言よりも後ろに置く。 */
function sortKey(message: ChatMessageView): number {
  return message.seq === UNSAVED_SEQ ? Number.POSITIVE_INFINITY : message.seq;
}

import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { isLoadingMessages, isLoadingOlderMessages, loadOlderMessages, messages } from "../../state/chat";
import { activeTeraId } from "../../state/session";
import type { ChatItem } from "./timeline";

/** 古いページを足す前に控えた、スクロールの大きさと位置。 */
type OlderAnchor = {
  teraId: string;
  /** 読み込み前の先頭のメッセージ。前が変わらなければ、読めたページは無い。 */
  firstId: string | null;
  /** 読み込み前の scrollHeight。 */
  height: number;
  /** 読み込み前の scrollTop。 */
  top: number;
};

/**
 * 履歴の読み足しと、スクロール位置の保持。
 *
 * 上端に近づいたら前のページを読み、読み終わっても読んでいた位置が動かないようにする。
 * 新しい内容が来たときだけ末尾へ追従し、上へ遡っている間は引き戻さない。
 */
export function useOlderPages(input: { items: readonly ChatItem[]; streaming: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 末尾にいるかどうか。履歴を読んでいる間は引き戻さない。 */
  const stickToBottom = useRef(true);
  /** 古いページを足す前に控えた、スクロールの大きさと位置。 */
  const olderAnchor = useRef<OlderAnchor | null>(null);

  // Tera を開き直したら、最新（末尾）から見せる。
  useLayoutEffect(() => {
    stickToBottom.current = true;
  }, [activeTeraId.value]);

  // 新しい内容が来たら末尾へ寄せる。
  // DOM を更新した直後（スクロールイベントより先）に動かし、
  // 増えた高さを「利用者が上へ動いた」と取り違えないようにする。
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [input.items, input.streaming]);

  // 古いページを足したら、読んでいた位置を保つ。
  useLayoutEffect(() => {
    const anchor = olderAnchor.current;
    const node = scrollRef.current;
    if (anchor === null || node === null) return;

    // 履歴の読み直し（Tera の切り替えを含む）が始まったら、控えた位置は捨てる。
    if (isLoadingMessages.value || anchor.teraId !== activeTeraId.value) {
      olderAnchor.current = null;
      return;
    }
    // まだ古いページが届いていない。
    if (isLoadingOlderMessages.value) return;
    // 先頭が変わっていなければ、読めたページは無い。
    if ((messages.value[0]?.id ?? null) === anchor.firstId) {
      olderAnchor.current = null;
      return;
    }
    // 末尾へ追従しているときは、そちらに任せる。
    if (stickToBottom.current) {
      olderAnchor.current = null;
      return;
    }

    olderAnchor.current = null;
    node.scrollTop = anchor.top + (node.scrollHeight - anchor.height);
  }, [messages.value, isLoadingMessages.value, isLoadingOlderMessages.value]);

  // 上端に近づいたら、その前のページを読む。読む前にスクロール位置を控える。
  const requestOlder = (): void => {
    const node = scrollRef.current;
    if (node === null) return;

    const height = node.scrollHeight;
    const top = node.scrollTop;
    const firstId = messages.value[0]?.id ?? null;
    // 画面が埋まっていないときは、読み込み後も末尾（最新）に寄せたままにする。
    const fill = height <= node.clientHeight + 1;
    if (!loadOlderMessages()) return;

    if (fill) {
      stickToBottom.current = true;
      return;
    }

    const teraId = activeTeraId.value;
    if (teraId !== null) olderAnchor.current = { teraId, firstId, height, top };
  };

  const handleScroll = (): void => {
    const node = scrollRef.current;
    if (node === null) return;

    // 最下部の近くにいるときだけ、これから来る内容に追従する。
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;

    // 上端に近づいたら、前のページを読む。
    if (node.scrollTop < 32) requestOlder();
  };

  // 最初のページが画面に満たないときは、スクロールが生まれるまで読む。
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    if (node.scrollHeight > node.clientHeight + 1) return;

    requestOlder();
  }, [input.items]);

  return { scrollRef, handleScroll };
}

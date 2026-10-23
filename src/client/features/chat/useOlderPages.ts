import { useCallback, useEffect, useLayoutEffect, useRef } from "preact/hooks";
import {
  isLoadingMessages,
  isLoadingOlderMessages,
  loadOlderMessages,
  messages,
  sentMessageCount,
} from "../../state/chat";
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

/** 末尾からこの距離までなら、新しい内容に追従しているとみなす。 */
const STICK_DISTANCE = 48;
/** 上端からこの距離まで来たら、その前のページを読む。 */
const OLDER_DISTANCE = 32;
/**
 * 送信時の滑らかな移動を、追従の判定から外しておく時間。
 * scrollend を返すブラウザでは、そちらで先に解除する。
 */
const SMOOTH_SETTLE_MS = 900;

/**
 * 履歴の読み足しと、スクロール位置の保持。
 *
 * 上端に近づいたら前のページを読み、読み終わっても読んでいた位置が動かないようにする。
 * 新しい内容が来たときだけ末尾へ追従し、上へ遡っている間は引き戻さない。
 * ただし、発言を送ったときだけは、どこを読んでいても末尾へ戻す
 * （送った本人が、自分の発言を見失わないようにするため）。
 */
export function useOlderPages(input: { items: readonly ChatItem[]; streaming: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 末尾にいるかどうか。履歴を読んでいる間は引き戻さない。 */
  const stickToBottom = useRef(true);
  /** 送信時の滑らかな移動の最中か。最中のスクロール位置は、利用者の操作と区別する。 */
  const smoothScrolling = useRef(false);
  /** 滑らかな移動を解除するまでの控え。 */
  const smoothTimer = useRef<number | null>(null);
  /** 古いページを足す前に控えた、スクロールの大きさと位置。 */
  const olderAnchor = useRef<OlderAnchor | null>(null);
  /** 前回見た送信の回数。増えたときだけ末尾へ寄せる。 */
  const lastSent = useRef(sentMessageCount.value);
  /** 前回のスクロール位置。滑らかな移動の最中に上へ戻されたかを見る。 */
  const lastScrollTop = useRef(0);
  /** 内容（画像の読み込みや折り返し）の高さの変化を見る。 */
  const contentObserver = useRef<ResizeObserver | null>(null);

  const cancelSmooth = useCallback((): void => {
    smoothScrolling.current = false;
    if (smoothTimer.current !== null) {
      window.clearTimeout(smoothTimer.current);
      smoothTimer.current = null;
    }
  }, []);

  /** 送信時の移動を滑らかに始める。解除の取りこぼしに備えて、時間でも解除する。 */
  const beginSmooth = useCallback((): void => {
    smoothScrolling.current = true;
    if (smoothTimer.current !== null) window.clearTimeout(smoothTimer.current);
    smoothTimer.current = window.setTimeout(cancelSmooth, SMOOTH_SETTLE_MS);
  }, [cancelSmooth]);

  // Tera を開き直したら、最新（末尾）から見せる。走っている送信時の移動も畳む。
  useLayoutEffect(() => {
    stickToBottom.current = true;
    cancelSmooth();
  }, [activeTeraId.value, cancelSmooth]);

  // 発言を送ったら、どこを読んでいても末尾へ寄せる。
  // この移動の間は滑らかに追従し、移動が終わったら即座に合わせる。
  useLayoutEffect(() => {
    if (sentMessageCount.value === lastSent.current) return;
    lastSent.current = sentMessageCount.value;

    stickToBottom.current = true;
    const node = scrollRef.current;
    if (node === null) return;

    if (prefersReducedMotion()) {
      node.scrollTop = node.scrollHeight;
      return;
    }

    beginSmooth();
    scrollToBottom(node, "smooth");
  }, [sentMessageCount.value, beginSmooth]);

  // 新しい内容が来たら末尾へ寄せる。
  // DOM を更新した直後（スクロールイベントより先）に動かし、
  // 増えた高さを「利用者が上へ動いた」と取り違えないようにする。
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null || !stickToBottom.current) return;

    // 送信時の滑らかな移動の途中なら、行き先を新しい末尾へ付け替える
    // （その場で飛ばすと、送信直後の動きが途中で途切れて見える）。
    if (smoothScrolling.current) {
      scrollToBottom(node, "smooth");
      return;
    }
    node.scrollTop = node.scrollHeight;
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

  // 画像の読み込みなどで内容が伸びたときも、末尾にいる間は追従する。
  // 内容の要素は「空の画面」と入れ替わるので、ref の付け替えに合わせて監視し直す。
  const contentRef = useCallback((node: HTMLDivElement | null): void => {
    contentObserver.current?.disconnect();
    contentObserver.current = null;
    if (node === null) return;

    const observer = new ResizeObserver(() => {
      const scroll = scrollRef.current;
      if (scroll === null || !stickToBottom.current) return;
      scrollToBottom(scroll, smoothScrolling.current ? "smooth" : "auto");
    });
    observer.observe(node);
    contentObserver.current = observer;
  }, []);

  // 入力欄が伸びたり、窓の大きさが変わったときも、末尾にいる間は底に留める。
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;

    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom(node, smoothScrolling.current ? "smooth" : "auto");
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 利用者が自分で動かし始めたら、送信時の移動は「追従中」の扱いから外す。
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;

    const onUserScroll = (): void => cancelSmooth();
    const onScrollEnd = (): void => {
      if (!smoothScrolling.current) return;
      cancelSmooth();
      stickToBottom.current = distanceToBottom(node) < STICK_DISTANCE;
    };

    node.addEventListener("wheel", onUserScroll, { passive: true });
    node.addEventListener("touchstart", onUserScroll, { passive: true });
    node.addEventListener("pointerdown", onUserScroll);
    node.addEventListener("keydown", onUserScroll);
    node.addEventListener("scrollend", onScrollEnd);

    return () => {
      node.removeEventListener("wheel", onUserScroll);
      node.removeEventListener("touchstart", onUserScroll);
      node.removeEventListener("pointerdown", onUserScroll);
      node.removeEventListener("keydown", onUserScroll);
      node.removeEventListener("scrollend", onScrollEnd);
    };
  }, [cancelSmooth]);

  // 外れたときに、待っている解除と監視を残さない。
  useEffect(
    () => () => {
      cancelSmooth();
      contentObserver.current?.disconnect();
    },
    [cancelSmooth],
  );

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

    // 送信時の移動は末尾へ向かう（scrollTop が増える）。
    // 位置が上へ戻ったら、それは利用者の操作なので、追従中の扱いをやめる。
    if (smoothScrolling.current && node.scrollTop < lastScrollTop.current - 1) cancelSmooth();
    lastScrollTop.current = node.scrollTop;

    // 送信時にこちらから動かしている間の位置は、利用者が動いた位置ではない。
    if (smoothScrolling.current) return;

    // 最下部の近くにいるときだけ、これから来る内容に追従する。
    stickToBottom.current = distanceToBottom(node) < STICK_DISTANCE;

    // 上端に近づいたら、前のページを読む。
    if (node.scrollTop < OLDER_DISTANCE) requestOlder();
  };

  // 最初のページが画面に満たないときは、スクロールが生まれるまで読む。
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    if (node.scrollHeight > node.clientHeight + 1) return;

    requestOlder();
  }, [input.items]);

  return { scrollRef, contentRef, handleScroll };
}

/** 末尾までの残りの距離。 */
function distanceToBottom(node: HTMLElement): number {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
}

/** 末尾へ寄せる。滑らかに動かすかどうかは、呼ぶ側が決める。 */
function scrollToBottom(node: HTMLElement, behavior: ScrollBehavior): void {
  node.scrollTo({ top: node.scrollHeight, behavior });
}

/** 端末が動きを減らす設定なら、スクロールも即座に動かす。 */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

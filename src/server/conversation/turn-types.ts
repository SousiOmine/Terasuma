import type { ReplyLanguage } from "../../shared/language";
import type { ChatAttachment, ChatMessage } from "../../shared/api/message";
import type { Compaction } from "./compaction";
import type { AgentEngine } from "../agent/engine";
import type { Store } from "../data/store";

/**
 * 1 ターンの型と、やり直しの待ち。
 *
 * ターンの排他（turns.ts）と、イベントの流し方（turn-stream.ts）の両方が使う。
 * 型をどちらかに置くと互いを import して循環するので、ここに置く。
 */

export type TurnDeps = {
  store: Store;
  engine: AgentEngine;
  /** 過去の対話の圧縮。ターンの前に走っている分を待ち、ターンの後に次を決める。 */
  compaction: Compaction;
};

/** ターンを始めたきっかけ。 */
export type TurnOrigin =
  /** 利用者が送った。 */
  | { kind: "user" }
  /** ルーチンの実行。 */
  | { kind: "routine"; routineId: string; routineName: string };

/** 1 ターンの入力。 */
export type TurnInput = {
  /** ユーザーが書いた本文。 */
  content: string;
  /** ユーザーが添付したファイル。無ければ null。 */
  attachments: ChatAttachment[] | null;
  language: ReplyLanguage;
};

/** 応答の途中で足す、利用者の発言。 */
export type SteerInput = {
  /** ユーザーが書いた本文。 */
  content: string;
  /** ユーザーが添付したファイル。無ければ null。 */
  attachments: ChatAttachment[] | null;
};

export const RETRY_DELAYS_MS = [1_000, 3_000];

/** signal が立つか、待ち時間が過ぎるまで待つ。 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 1 つのターンの実行状態。 */
export type RunningTurn = {
  controller: AbortController;
  /** 利用者の「停止」で止めたかどうか。止められたことを失敗として扱わない。 */
  stopped: boolean;
  /** 保存したが、まだモデルへ渡していない発言（届いた順）。 */
  pending: ChatMessage[];
  /** このターンを始めたきっかけ。保存する発言の origin を決める。 */
  origin: TurnOrigin;
  /** このターンのイベント列が終わるまで解決しない。close() が保存の完了を待つのに使う。 */
  done: Promise<void>;
  /** done を解決する。ターンの finally から呼ぶ。 */
  finish(): void;
};


import type { ConversationEvent } from "../../shared/api/events";
import * as api from "../lib/api";
import { ApiError } from "../lib/http";

/**
 * 同じ Tera を開いている画面の購読。
 *
 * 「購読を張る → 届いた順に渡す → 切れたら待って繋ぎ直す」という形は 1 つなので、
 * ここに置く。何を状態へ反映するかは呼び出し側（chat.ts）が決める。
 */

/** 購読が切れたときに、繋ぎ直すまでの待ち。試すたびに倍にし、上限で止める。 */
const RESUBSCRIBE_DELAY_MS = 500;
const RESUBSCRIBE_MAX_DELAY_MS = 5_000;

export type ConversationSubscription = {
  /** この購読がまだ現役か（Tera を切り替えたら、古い購読を捨てる）。 */
  isActive(generation: number): boolean;
  /** 届いたイベントを、画面の状態へ反映する。 */
  onEvent(teraId: string, event: ConversationEvent): void;
};

/**
 * 購読を張り、切れたら繋ぎ直す。
 * 戻り値の AbortSignal が立つと、繋ぎ直しもやめる。
 */
export function openConversationSubscription(
  teraId: string,
  generation: number,
  subscription: ConversationSubscription,
): AbortController {
  const controller = new AbortController();
  void follow(teraId, generation, controller, subscription);
  return controller;
}

async function follow(
  teraId: string,
  generation: number,
  controller: AbortController,
  subscription: ConversationSubscription,
): Promise<void> {
  let attempt = 0;

  while (!controller.signal.aborted && subscription.isActive(generation)) {
    try {
      for await (const event of api.streamConversation(teraId, controller.signal)) {
        // 1 つでも届いたら、次に切れたときはすぐ繋ぎ直す。
        attempt = 0;
        subscription.onEvent(teraId, event);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      // 消えた Tera を購読し続けても意味が無いので、繋ぎ直さずにやめる。
      if (error instanceof ApiError && error.code === "tera_not_found") return;
    }

    if (controller.signal.aborted || !subscription.isActive(generation)) return;
    await delay(Math.min(RESUBSCRIBE_DELAY_MS * 2 ** attempt, RESUBSCRIBE_MAX_DELAY_MS));
    attempt += 1;
  }
}

/** 待ってから、次の繋ぎ直しを試す。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

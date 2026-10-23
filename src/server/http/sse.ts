import { encodeChatEvent } from "../../shared/sse";
import type { ChatEvent } from "../../shared/api/message";

/**
 * 1 ターン分のイベントを SSE として流す。
 *
 * クライアントが読むたびに、次のイベントを 1 つずつ返す。pull ベースなので、
 * 相手が読まなくなれば cancel が呼ばれ、生成側も止まる。
 *
 * 次のイベントが来ないまま間隔が空いたら、コメント行を流して接続を保つ。
 * 止まった待ち（ユーザーの操作、長い思考）で切れないようにするため。
 * タイマーは待っている間だけ動かし、イベントが来たら必ず止める。
 */

/**
 * 待ちの接続に流す心拍の間隔。
 * Bun の待ち受けは、何も流さない接続を既定の 10 秒で切る（実測で 12 秒）。
 * ユーザーの操作を待つ間や、モデルが長く考えている間も切れないよう、これより短くする。
 */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** 何も流れない間に流すコメント行（SSE の仕様上、読む側は無視する）。 */
const HEARTBEAT_FRAME = ": heartbeat\n\n";

export function createSseResponse(events: AsyncIterable<ChatEvent>): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let pending: Promise<IteratorResult<ChatEvent>> | null = null;
  let heartbeat: ReturnType<typeof setTimeout> | null = null;

  function stopHeartbeat(): void {
    if (heartbeat === null) return;

    clearTimeout(heartbeat);
    heartbeat = null;
  }

  /** 心拍までの待ち。イベントが先に来ても、タイマーは stopHeartbeat が片付ける。 */
  function nextHeartbeat(): Promise<{ kind: "heartbeat" }> {
    return new Promise((resolve) => {
      heartbeat = setTimeout(() => resolve({ kind: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
    });
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // 前回の pull で待ち続けている分があれば、それをそのまま使う。
      pending ??= iterator.next();

      const outcome = await Promise.race([
        pending.then((result) => ({ kind: "event" as const, result })),
        nextHeartbeat(),
      ]);
      stopHeartbeat();

      // 相手が読むのをやめた直後は、流す先が無い。
      if (controller.desiredSize === null) return;

      if (outcome.kind === "heartbeat") {
        controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
        return;
      }

      pending = null;
      if (outcome.result.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(encodeChatEvent(outcome.result.value)));
    },
    async cancel() {
      stopHeartbeat();
      await iterator.return?.(undefined);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

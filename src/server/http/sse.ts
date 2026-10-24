import { SECURITY_HEADERS } from "./security";

/**
 * 1 本のイベント列を SSE として流す。
 *
 * クライアントが読むたびに、次のイベントを 1 つずつ返す。pull ベースなので、
 * 相手が読まなくなれば cancel が呼ばれる。ふつうはそこで生成側も止めるが、
 * continueOnCancel が true なら、読む人がいなくても最後まで読み切る
 * （送信の応答では、画面を切り替えてもターンを止めないため）。
 *
 * 次のイベントが来ないまま間隔が空いたら、コメント行を流して接続を保つ。
 * 止まった待ち（ユーザーの操作、長い思考、ほかの画面の送信待ち）で切れないようにするため。
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

export type SseOptions = {
  /**
   * 読み手が離れても、イベント列を最後まで読むか。
   * 送信の応答では true（画面を切り替えてもターンを止めない）。購読では false（離れたら閉じる）。
   */
  continueOnCancel?: boolean;
};

export function createSseResponse<T>(
  events: AsyncIterable<T>,
  encode: (event: T) => string,
  options: SseOptions = {},
): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let pending: Promise<IteratorResult<T>> | null = null;
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
      controller.enqueue(encoder.encode(encode(outcome.result.value)));
    },
    async cancel() {
      stopHeartbeat();

      // 画面を離れても、ターンは止めない。読む人がいない間も読み切って、
      // 出来事を broadcast へ流し続ける（戻った画面は購読で続きを受け取る）。
      if (options.continueOnCancel === true) {
        void drain(iterator);
        return;
      }

      await iterator.return?.(undefined);
    },
  });

  return new Response(body, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/** 読み手がいなくても、イベント列を最後まで読む（捨てる）。 */
async function drain<T>(iterator: AsyncIterator<T>): Promise<void> {
  try {
    for (;;) {
      const result = await iterator.next();
      if (result.done === true) return;
    }
  } catch {
    // ターンの失敗はイベント（error）として流れている。ここでは黙って終わる。
  }
}

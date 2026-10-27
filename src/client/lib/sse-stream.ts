import { ApiError } from "./http";

/**
 * SSE の応答を、イベントへ戻しながら順に返す。
 *
 * 送信の応答と、ほかの画面の更新の購読が、同じ読み方をする。
 * 切り分けの規則は shared/sse.ts（サーバと共有）が持ち、ここは通信の読み取りだけを持つ。
 */

/** SSE の応答を、イベントへ戻しながら順に返す。送信の応答と購読で同じ読み方をする。 */
export async function* readEvents<T>(
  response: Response,
  decode: (buffer: string) => { events: T[]; rest: string },
  signal: AbortSignal,
): AsyncGenerator<T> {
  if (response.body === null) throw new ApiError("internal_error", "response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const { events, rest } = decode(buffer);
      buffer = rest;
      for (const event of events) yield event;
    }
  } catch (error) {
    // 利用者の「停止」や画面の切り替えは失敗ではないので、そのまま終わる。
    if (signal.aborted) return;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

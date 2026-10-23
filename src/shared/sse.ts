import { isChatEvent, isConversationEvent } from "./chat-event";
import type { ConversationEvent } from "./api/events";
import type { ChatEvent } from "./api/message";

/**
 * SSE のフレームとイベントの変換。
 *
 * 会話には 2 種類の流れがある（送信の応答と、ほかの画面からの更新の購読）。
 * フレームの切り出しは同じなので、読む先の型だけを差し替えて 1 か所に置く。
 * 改行は "\n" に統一する（送受信ともこのモジュールが担当するため）。
 */

/** イベント 1 つを SSE のフレームにする。 */
function encodeEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 送信の応答で流れるイベントを、SSE のフレームにする。 */
export function encodeChatEvent(event: ChatEvent): string {
  return encodeEvent(event);
}

/** 会話の購読で流れるイベントを、SSE のフレームにする。 */
export function encodeConversationEvent(event: ConversationEvent): string {
  return encodeEvent(event);
}

/**
 * 受信バッファを SSE フレーム単位で切り出し、イベントとして読む。
 * 未完のフレームは rest として返すので、次のチャンクと連結して再度渡すこと。
 *
 * 自分たちが生成したストリームしか読まない前提なので、JSON として読めないフレームは
 * そのまま捨てずに例外にする（捨てると原因の分からない取りこぼしになる）。
 */
function decodeEvents<T>(buffer: string, isEvent: (value: unknown) => value is T): { events: T[]; rest: string } {
  const events: T[] = [];
  let cursor = 0;

  for (;;) {
    const boundary = buffer.indexOf("\n\n", cursor);
    if (boundary === -1) break;

    const frame = buffer.slice(cursor, boundary);
    cursor = boundary + 2;

    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (data.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      throw new Error(`JSON として読めない SSE フレームを受け取った: ${data}`, { cause: error });
    }
    if (!isEvent(parsed)) throw new Error(`読めない SSE のイベントを受け取った: ${data}`);
    events.push(parsed);
  }

  return { events, rest: buffer.slice(cursor) };
}

/** 送信の応答のストリームを、イベントへ戻す。 */
export function decodeChatEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  return decodeEvents(buffer, isChatEvent);
}

/** 会話の購読のストリームを、イベントへ戻す。 */
export function decodeConversationEvents(buffer: string): { events: ConversationEvent[]; rest: string } {
  return decodeEvents(buffer, isConversationEvent);
}

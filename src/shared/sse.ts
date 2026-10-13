import type { ChatEvent } from "./types";

/**
 * ChatEvent を SSE のフレームに変換する。
 * 改行は "\n" に統一する（送受信ともこのモジュールが担当するため）。
 */
export function encodeChatEvent(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * 受信バッファを SSE フレーム単位で切り出す。
 * 未完のフレームは rest として返すので、次のチャンクと連結して再度渡すこと。
 *
 * 自分たちが生成したストリームしか読まない前提なので、JSON として読めないフレームは
 * そのまま捨てずに例外にする（捨てると原因の分からない取りこぼしになる）。
 */
export function decodeChatEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  const events: ChatEvent[] = [];
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
    events.push(parsed as ChatEvent);
  }

  return { events, rest: buffer.slice(cursor) };
}

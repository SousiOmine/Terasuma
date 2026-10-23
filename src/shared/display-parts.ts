import { CHAT_SERVER_ID, UI_TOOL } from "./tools";
import type { MessagePart } from "./types";

/**
 * 画面が描く部品かどうか。
 *
 * 本文・添付・注記と、チャットのカード（chat_ui）の呼び出しだけを画面に出す。
 * ツールの引数と結果は画面に使わないので、履歴を読むときにも運ばない。
 * サーバ（送る前の絞り込み）とクライアント（描く前の絞り込み）で同じ判定を使う。
 */
export function isDisplayPart(part: MessagePart): boolean {
  switch (part.type) {
    case "text":
    case "attachment":
    case "notice":
      return true;
    case "tool-call":
      return part.server === CHAT_SERVER_ID && part.tool === UI_TOOL;
    case "tool-result":
      return false;
  }
}

import { isDisplayPart } from "../../shared/display-parts";
import type { ChatMessage } from "../../shared/types";

/**
 * 画面へ渡すメッセージ。
 *
 * 保存した記録はツールの結果も含むが、画面は本文・添付・注記・チャットのカードしか描かない。
 * 送る直前にこの形へ絞り、履歴を読むたびに大きな文字列を運ばないようにする。
 * 記録そのもの（store）は書き換えない。モデルへ渡す文脈は full の parts を使う。
 */
export function toMessageView(message: ChatMessage): ChatMessage {
  const parts = message.parts;
  if (parts === null) return message;

  const display = parts.filter(isDisplayPart);
  if (display.length === parts.length) return message;
  return { ...message, parts: display };
}

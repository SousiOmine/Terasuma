import { isDisplayPart } from "../../shared/display-parts";
import type { ChatMessage, ChatMessageView } from "../../shared/api/message";

/**
 * 画面へ渡すメッセージ。
 *
 * 保存した記録はツールの結果も含むが、画面は本文・添付・注記・チャットのカードしか描かない。
 * 送る直前にこの形へ絞り、履歴を読むたびに大きな文字列を運ばないようにする。
 * 記録そのもの（store）は書き換えない。モデルへ渡す文脈は full の parts を使う。
 */
export function toMessageView(message: ChatMessage): ChatMessageView {
  return {
    id: message.id,
    teraId: message.teraId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    // 添付のパスはコンテナの中の場所。画面は名前と大きさだけを使う。
    attachments: message.attachments === null ? null : message.attachments.map(({ name, size }) => ({ name, size })),
    parts: message.parts === null ? null : message.parts.filter(isDisplayPart),
    createdAt: message.createdAt,
  };
}

import { formatBytes } from "../../shared/attachments";
import type { ChatAttachment, ChatMessage } from "../../shared/types";

/**
 * モデルへ渡す本文の組み立て。
 *
 * 保存されているメッセージの content と attachments を土台に、モデルにだけ必要な案内を
 * ここで組み立てる。画面の本文をモデル向けに作り直すのではなく、モデル向けの本文を
 * 画面の内容から派生させる。逆方向（画面の内容をモデル向けに合わせる）はしない。
 */

/** ユーザー発言を、モデルへ渡す本文にする。 */
export function userContentForModel(message: ChatMessage): string {
  const attachments = message.attachments;
  if (attachments === null || attachments.length === 0) return message.content;
  return withAttachmentNotice(message.content, attachments);
}

/** 添付ファイルの案内。モデル向けなので英語で揃える。 */
export function attachmentNotice(attachments: readonly ChatAttachment[]): string {
  if (attachments.length === 0) return "";

  return [
    "[Attached files]",
    "The user attached these files. They are inside the computer:",
    ...attachments.map((file) => `- ${file.name}: ${file.path} (${formatBytes(file.size)})`),
    "",
    "Open them with the read or bash tools.",
  ].join("\n");
}

/** 画面の本文の後ろに、添付ファイルの案内を足す。 */
export function withAttachmentNotice(content: string, attachments: readonly ChatAttachment[]): string {
  if (attachments.length === 0) return content;

  const notice = attachmentNotice(attachments);
  return content.length === 0 ? notice : `${content}\n\n${notice}`;
}

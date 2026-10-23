import { isChatAttachment, isMessagePart } from "../../../shared/chat-event";
import type { ChatAttachment, ChatMessage, MessagePart, MessageRole, Tera } from "../../../shared/api/message";

/** SQLite の行と、ドメインの型の対応。 */

export type TeraRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
};

export type MessageRow = {
  id: string;
  tera_id: string;
  seq: number;
  role: string;
  content: string;
  attachments: string | null;
  parts: string | null;
  created_at: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
};

export function toTera(row: TeraRow): Tera {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function toMessage(row: MessageRow): ChatMessage {
  const usage =
    row.input_tokens === null && row.output_tokens === null && row.cached_input_tokens === null
      ? null
      : {
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          cachedInputTokens: row.cached_input_tokens ?? 0,
        };

  return {
    id: row.id,
    teraId: row.tera_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: row.content,
    attachments: readAttachments(row),
    parts: readParts(row),
    createdAt: row.created_at,
    usage,
  };
}

/** 画面に出す添付ファイルを読み戻す。読めない値は黙って捨てず、そのまま失敗させる。 */
function readAttachments(row: MessageRow): ChatAttachment[] | null {
  if (row.attachments === null) return null;

  const parsed: unknown = JSON.parse(row.attachments);
  if (!Array.isArray(parsed) || !parsed.every(isChatAttachment)) {
    throw new Error(`メッセージ ${row.id} の attachments は添付ファイルの配列ではありません`);
  }
  return parsed;
}

/** 保存されている部分を読み戻す。読めない値は黙って捨てず、そのまま失敗させる。 */
function readParts(row: MessageRow): MessagePart[] | null {
  if (row.parts === null) return null;

  const parsed: unknown = JSON.parse(row.parts);
  if (!Array.isArray(parsed) || !parsed.every(isMessagePart)) {
    throw new Error(`メッセージ ${row.id} の parts は部品の配列ではありません`);
  }
  return parsed;
}

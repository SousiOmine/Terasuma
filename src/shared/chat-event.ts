import { API_ERROR_CODES } from "./types";
import type { ChatAttachment, ChatEvent, ChatMessage, ImageRef, MessagePart, TokenUsage } from "./types";

/**
 * 通信と保存データの形を、実行時に確かめる。
 *
 * 型はコンパイル時にしか効かない。SSE のフレームや保存された parts は、
 * 壊れた値がそのまま画面やモデルへ流れると、原因の分かりにくい不具合になる。
 * 境界（外から来た値）だけを、ここで確かめる。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): value is TokenUsage {
  return (
    isRecord(value) && isNumber(value.inputTokens) && isNumber(value.outputTokens) && isNumber(value.cachedInputTokens)
  );
}

function isImageRef(value: unknown): value is ImageRef {
  return (
    isRecord(value) && isString(value.sha256) && isString(value.mime) && isNumber(value.width) && isNumber(value.height)
  );
}

/** 画面に出す添付ファイル 1 件。 */
export function isChatAttachment(value: unknown): value is ChatAttachment {
  return isRecord(value) && isString(value.name) && isNumber(value.size) && isString(value.path);
}

/** 保存・送信されるメッセージの部品 1 つ。 */
export function isMessagePart(value: unknown): value is MessagePart {
  if (!isRecord(value)) return false;

  switch (value.type) {
    case "text":
      return isString(value.text);
    case "tool-call":
      return isString(value.id) && isString(value.server) && isString(value.tool) && "args" in value;
    case "tool-result":
      return (
        isString(value.id) &&
        isString(value.server) &&
        isString(value.tool) &&
        typeof value.failed === "boolean" &&
        isString(value.output) &&
        (value.images === undefined || (Array.isArray(value.images) && value.images.every(isImageRef)))
      );
    default:
      return false;
  }
}

/** 1 件のメッセージ。 */
export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;

  return (
    isString(value.id) &&
    isString(value.teraId) &&
    isNumber(value.seq) &&
    (value.role === "user" || value.role === "assistant") &&
    isString(value.content) &&
    (value.attachments === null || (Array.isArray(value.attachments) && value.attachments.every(isChatAttachment))) &&
    (value.parts === null || (Array.isArray(value.parts) && value.parts.every(isMessagePart))) &&
    isNumber(value.createdAt) &&
    (value.usage === null || isUsage(value.usage))
  );
}

/** SSE で流れてくるイベント 1 つ。 */
export function isChatEvent(value: unknown): value is ChatEvent {
  if (!isRecord(value)) return false;

  switch (value.type) {
    case "user-message":
    case "assistant-done":
      return isChatMessage(value.message);
    case "assistant-start":
      return isString(value.id) && isNumber(value.createdAt);
    case "text-delta":
      return isString(value.id) && isString(value.delta);
    case "tool-call":
      return isString(value.id) && isMessagePart(value.part) && value.part.type === "tool-call";
    case "tool-result":
      return isString(value.id) && isMessagePart(value.part) && value.part.type === "tool-result";
    case "error":
      return (
        isString(value.code) &&
        (API_ERROR_CODES as readonly string[]).includes(value.code) &&
        (value.detail === null || isString(value.detail))
      );
    default:
      return false;
  }
}

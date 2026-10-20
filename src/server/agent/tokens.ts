import type { ChatMessage } from "../../shared/types";
import type { CompactionState } from "../data/store";
import { userContentForModel } from "./model-content";
import { summaryText } from "./prompt";

/**
 * 文脈の大きさの見積もり。
 *
 * トークナイザは持たない。閾値の判定にだけ使う近似なので、
 * 半角は 4 文字で 1 トークン、それ以外（日本語など）は 1 文字で 1 トークンとして数える。
 */

/** 画像 1 枚の目安。実際の消費は大きさとプロバイダで変わるが、数える対象があることは忘れない。 */
const IMAGE_TOKENS = 1_000;

/** テキストのトークン数の目安。 */
export function estimateTokens(text: string): number {
  let wide = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= 0x80) wide += 1;
  }
  return Math.ceil((text.length - wide) / 4 + wide);
}

/** メッセージ 1 件のトークンの目安。parts があるときは部品ごとに数える（本文は parts の text の連結）。 */
export function estimateMessageTokens(message: ChatMessage): number {
  if (message.parts === null) {
    const content = message.role === "user" ? userContentForModel(message) : message.content;
    return estimateTokens(content);
  }

  let total = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        total += estimateTokens(part.text);
        break;
      case "tool-call":
        total += estimateTokens(JSON.stringify(part.args) ?? "");
        break;
      case "tool-result":
        total += estimateTokens(part.output) + (part.images?.length ?? 0) * IMAGE_TOKENS;
        break;
    }
  }
  return total;
}

/** メッセージの並びのトークン数の目安。 */
export function sumTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/**
 * 文脈のトークンの目安。
 * 最後のモデル呼び出しの usage が最も正確なので、それを土台にし、それより後の分だけ足す。
 * usage が無い（usage を返さないプロバイダ、中断したターン）ときは、全文を文字数から見積もる。
 */
export function contextTokens(state: CompactionState, messages: readonly ChatMessage[]): number {
  // 圧縮より前の usage は、畳む前の広い文脈を指す。畳んだ直後にまた畳まないよう、使わない。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) break;
    if (message.role !== "assistant" || message.usage === null) continue;
    if (message.createdAt <= state.createdAt) break;

    let trailing = 0;
    for (let after = index + 1; after < messages.length; after += 1) {
      const rest = messages[after];
      if (rest !== undefined) trailing += estimateMessageTokens(rest);
    }
    return message.usage.inputTokens + message.usage.outputTokens + trailing;
  }

  // 要約も文脈の一部なので、見積もりには含める。
  return (state.summary === "" ? 0 : estimateTokens(summaryText(state.summary))) + sumTokens(messages);
}

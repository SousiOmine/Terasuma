import type { ChatMessage, MessagePart, TokenUsage } from "../../shared/api/message";
import type { MessageLog } from "../data/store/types";
import { toolNameFor, UI_TOOL_NAME } from "../../shared/tools";

/** いま書き込んでいるステップの行。 */
export type StepDraft = {
  id: string;
  createdAt: number;
  /** 予約した連番。画面はこの位置へ置く。 */
  seq: number;
  /** このステップの記録（本文・ツール・添付・注記）。保存される並びそのもの。 */
  parts: MessagePart[];
};

export type StepMessages = {
  /** いま書き込んでいる行。 */
  current(): StepDraft;
  /** ステップの境目。いまの行を確定し、次の行を予約して返す。 */
  nextStep(usage: TokenUsage | null): StepDraft;
  /** ターンの終わり。いまの行を確定する（何も出ていなければ null）。 */
  finish(usage: TokenUsage | null): ChatMessage | null;
  /** このターンで、ユーザーの目に触れる内容が 1 つでもあったか。 */
  sawContent(): boolean;
};

/**
 * 1 ターンの中の、モデルのステップごとの行を持つ。
 *
 * 行はステップの開始時に予約する。連番は保存した順に付くので、終わってから作ると、
 * 生成中に届いた追加の発言（steering）のほうが先の連番になり、画面でも履歴でも
 * 割り込みが応答の上に並ぶ。何も出なかったステップの行は残さない。
 */
export function createStepMessages(store: MessageLog, teraId: string): StepMessages {
  let draft = reserve();
  let content = false;

  function reserve(): StepDraft {
    const message = store.appendMessage({
      id: crypto.randomUUID(),
      teraId,
      role: "assistant",
      content: "",
      attachments: null,
      parts: [],
    });

    return { id: message.id, createdAt: message.createdAt, seq: message.seq, parts: [] };
  }

  function commit(target: StepDraft, usage: TokenUsage | null): ChatMessage | null {
    if (target.parts.length === 0) {
      store.deleteMessage(target.id);
      return null;
    }

    if (hasVisiblePart(target.parts)) content = true;

    // 予約した行が何かの理由で消えていたら、同じ id で作り直す（連番は末尾になる）。
    return (
      store.updateMessageParts(target.id, { parts: target.parts, usage }) ??
      store.appendMessage({
        id: target.id,
        teraId,
        role: "assistant",
        content: "",
        attachments: null,
        parts: target.parts,
        usage,
      })
    );
  }

  return {
    current() {
      return draft;
    },

    nextStep(usage) {
      commit(draft, usage);
      draft = reserve();
      return draft;
    },

    finish(usage) {
      return commit(draft, usage);
    },

    sawContent() {
      return content;
    },
  };
}

/** ユーザーの目に触れる部分があるかどうか。 */
export function hasVisiblePart(parts: readonly MessagePart[]): boolean {
  return parts.some(
    (part) =>
      (part.type === "text" && part.text.trim().length > 0) ||
      part.type === "attachment" ||
      part.type === "notice" ||
      // カードを出しただけのターンも、ユーザーの目には何かが届いている。
      (part.type === "tool-call" && toolNameFor(part.server, part.tool) === UI_TOOL_NAME),
  );
}

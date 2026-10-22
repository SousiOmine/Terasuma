import { toolNameFor } from "../../shared/tools";
import type { ChatMessage, MessagePart } from "../../shared/types";
import { userContentForModel } from "./model-content";

/**
 * 圧縮（要約）に渡す文の組み立てと、要約の指示。
 *
 * 会話をそのまま見せると続きを書かせてしまうので、発言の頭に役割を付けた平文にする。
 * 出力の形は定型の見出しに揃え、要約として使えるかを assertSummary で確かめる。
 */

/** 要約に見せるツールの結果 1 件の上限。長い出力で呼び出しが膨らむのを防ぐ。 */
const TOOL_RESULT_MAX_CHARS = 2_000;

/** 要約に見せるツールの呼び出し 1 件の上限。UI のマークアップなどで呼び出しが膨らむのを防ぐ。 */
const TOOL_CALL_MAX_CHARS = 600;

/** 要約への指示。会話を続けさせないため、応答ではなく要約だけを書かせる。 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** 要約の呼び出しに渡す本文。変わる情報は末尾へ置く（プロンプトキャッシュの規則と同じ並べ方）。 */
export function conversationPrompt(messages: readonly ChatMessage[], previousSummary: string): string {
  const parts = [`<conversation>\n${serializeConversation(messages)}\n</conversation>`];
  if (previousSummary !== "") parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
  parts.push(previousSummary === "" ? SUMMARY_PROMPT : UPDATE_SUMMARY_PROMPT);
  return parts.join("\n\n");
}

/**
 * 要約として使えるかを確かめる。
 * 中身が無いまま畳むと、畳んだはずのやり取りがどこにも残らなくなる。
 */
export function assertSummary(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("要約の結果が空でした");
  if (!/^## /m.test(trimmed)) {
    throw new Error(`要約に決まった見出しがありません: ${trimmed.slice(0, 200)}`);
  }
}

/**
 * 会話を、要約に見せる平文にする。
 * 会話として続きを書かせないよう、発言の頭に役割を付ける。
 * ツールの結果は長いので切り詰める（要約に全部は要らない）。
 */
export function serializeConversation(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`[User]: ${userContentForModel(message)}`);
      continue;
    }

    if (message.parts === null) {
      throw new Error(`assistant メッセージ ${message.id} に parts がありません`);
    }

    const text = message.parts
      .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.length > 0) lines.push(`[Assistant]: ${text}`);

    const calls = message.parts.filter(
      (part): part is Extract<MessagePart, { type: "tool-call" }> => part.type === "tool-call",
    );
    if (calls.length > 0) {
      lines.push(`[Assistant tool calls]: ${calls.map(formatCall).join("; ")}`);
    }

    for (const part of message.parts) {
      if (part.type !== "tool-result") continue;

      const label = part.failed ? "Tool result (failed)" : "Tool result";
      const images = (part.images ?? []).map((image) => ` [image ${image.width}x${image.height}]`).join("");
      lines.push(`[${label}]: ${truncate(part.output)}${images}`);
    }
  }

  return lines.join("\n\n");
}

/** ツールの呼び出しを、`名前(引数)` の形にする。 */
function formatCall(part: Extract<MessagePart, { type: "tool-call" }>): string {
  return truncate(`${toolNameFor(part.server, part.tool)}(${formatArgs(part.args)})`, TOOL_CALL_MAX_CHARS);
}

/** 引数を `key=値` の並びにする。オブジェクトでなければ、そのまま JSON にする。 */
function formatArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return jsonOf(args);

  return Object.entries(args as Record<string, unknown>)
    .map(([key, value]) => `${key}=${jsonOf(value)}`)
    .join(", ");
}

function jsonOf(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

/** 要約に見せる本文を、決めた長さに切る。切り詰めたことは本文に残す。 */
function truncate(text: string, limit: number = TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} more characters truncated]`;
}

/**
 * 最初の要約の指示。
 * 後から続きを担う別のモデルが読む前提で、目的・制約・進み具合・決めたこと・次にやることを残す。
 */
const SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, command lines, URLs, and error messages.`;

/**
 * 更新の指示。前の要約の情報を落とさずに、新しいやり取りを足す。
 * 要約を書き直す唯一の場所なので、古くなった項目はここで落とす。
 */
const UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, command lines, URLs, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, command lines, URLs, and error messages.`;

/** ターンの途中で切ったときの、前半の要約の指示。 */
export const TURN_PREFIX_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

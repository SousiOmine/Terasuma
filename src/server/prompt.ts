import type { ChatMessage, MessagePart } from "../shared/types";

/**
 * モデルへ渡す system プロンプト。
 *
 * プロンプトキャッシュは、リクエストの先頭が前回と一致するほど当たる。
 * ここには絶対に可変値を入れない。日時・ユーザー名・件数・ファイル一覧などを混ぜると、
 * 先頭が一致しなくなり、毎回キャッシュが当たらなくなる。
 * 可変の情報をモデルへ渡したくなったら、履歴の末尾（最後の user メッセージの後ろ）に置くこと。
 */
export const SYSTEM_PROMPT = [
  "You are Terasuma, a general-purpose assistant running on the user's own machine.",
  "Answer directly and concisely.",
  "Always reply in the language the user writes in.",
].join("\n");

/** モデルへ渡す assistant の内容の一部。 */
export type AssistantContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

/** モデルへ渡すツールの結果。 */
export type ToolResultContentPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  /** 失敗した呼び出しは error-text にして、モデルが自分で直せるようにする。 */
  output: { type: "text" | "error-text"; value: string };
};

/**
 * モデルへ渡す会話 1 件分。
 * ツールを使ったターンは assistant（本文とツール呼び出し）と tool（その結果）の 2 件になる。
 */
export type ModelInputMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | AssistantContentPart[] }
  | { role: "tool"; content: ToolResultContentPart[] };

/** ツール呼び出しの名前。接続側が付けた "<サーバー id>_<ツール名>" を組み立て直す。 */
export function toolNameFor(server: string, tool: string): string {
  return server.length === 0 ? tool : `${server}_${tool}`;
}

/**
 * 保存済み履歴を、モデルへ渡す形に開く。
 * 要約・言い換え・並べ替えはしない（プロンプトキャッシュを当て続けるため、末尾への追記だけにする）。
 */
export function toModelMessages(history: readonly ChatMessage[]): ModelInputMessage[] {
  const messages: ModelInputMessage[] = [];

  for (const message of history) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content });
      continue;
    }

    const parts = message.parts;
    if (parts === null) {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    messages.push({ role: "assistant", content: toAssistantParts(parts, message.content) });

    const results = toToolResults(parts);
    if (results.length > 0) messages.push({ role: "tool", content: results });
  }

  return messages;
}

/**
 * モデルへ実際に渡る入力の仕様。
 *
 * Mastra の Agent には instructions（= SYSTEM_PROMPT）を渡しているので、プロバイダが受け取る
 * メッセージ列は「system 1 件 + toModelMessages() の結果」になる。ここはそのあるべき形を
 * 1 箇所で表現したもので、キャッシュ保護の回帰テスト（tests/prompt-cache.test.ts）が参照する。
 */
export function buildModelInput(history: readonly ChatMessage[]): ModelInputMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...toModelMessages(history)];
}

/** 本文とツール呼び出しを、保存された順のまま並べる。 */
function toAssistantParts(parts: readonly MessagePart[], content: string): string | AssistantContentPart[] {
  if (!parts.some((part) => part.type === "tool-call")) return content;

  const blocks: AssistantContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text });
    else if (part.type === "tool-call") {
      blocks.push({
        type: "tool-call",
        toolCallId: part.id,
        toolName: toolNameFor(part.server, part.tool),
        input: part.args,
      });
    }
  }
  return blocks;
}

/** ツール呼び出しに対する結果を、呼び出しの順に並べる。 */
function toToolResults(parts: readonly MessagePart[]): ToolResultContentPart[] {
  const results = new Map<string, Extract<MessagePart, { type: "tool-result" }>>();
  for (const part of parts) {
    if (part.type === "tool-result") results.set(part.id, part);
  }

  const blocks: ToolResultContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "tool-call") continue;

    const result = results.get(part.id);
    blocks.push({
      type: "tool-result",
      toolCallId: part.id,
      toolName: toolNameFor(part.server, part.tool),
      output:
        result === undefined
          ? // 「停止」で結果が残らなかった呼び出し。結果を欠いたまま渡すとプロバイダが
            // 呼び出しと結果の対応を取れずに失敗するので、中断した事実だけを伝える。
            { type: "error-text", value: "この呼び出しは中断されたため、結果がありません" }
          : { type: result.failed ? "error-text" : "text", value: result.output },
    });
  }
  return blocks;
}

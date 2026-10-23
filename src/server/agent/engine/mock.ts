import type { ChatMessage, TokenUsage } from "../../../shared/api/message";
import { userContentForModel } from "../model-content";
import type { AgentEngine, EngineEvent } from "./index";

/** API キー無しで画面とストリーミングを確かめるためのモック。 */

/**
 * API キー無しで UI とストリーミングを確認するためのモックの LLM。
 * TERASUMA_ENGINE=mock を明示したときだけ使われ、自動で選ばれることはない。
 */
export function createMockEngine(options: { chunkSize?: number; delayMs?: number } = {}): AgentEngine {
  const chunkSize = options.chunkSize ?? 6;
  const delayMs = options.delayMs ?? 12;

  return {
    name: "mock",
    stream({ context, signal, replyLanguage }) {
      const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
      const userTurns = context.messages.filter((message) => message.role === "user").length;

      const reply =
        replyLanguage === "ja"
          ? [
              "[mock engine]",
              `これは偽の応答です。受け取った会話は ${context.messages.length} 件（うちユーザー発言 ${userTurns} 件）。`,
              `畳んだ要約: ${context.summary === null ? "まだありません" : `${context.summary.length} 文字`}`,
              `直前の発言: ${lastUser?.content ?? "(なし)"}`,
            ].join("\n")
          : [
              "[mock engine]",
              `This is a fake reply. Received ${context.messages.length} message(s) (${userTurns} from the user).`,
              `Compacted summary: ${context.summary === null ? "none yet" : `${context.summary.length} characters`}`,
              `Last message: ${lastUser?.content ?? "(none)"}`,
            ].join("\n");

      // 数値は文字数から作った当てずっぽう。実際のキャッシュの値ではない。
      const usage: TokenUsage = {
        inputTokens: context.messages.reduce((total, message) => total + messageTextLength(message), 0),
        outputTokens: reply.length,
        cachedInputTokens: 0,
      };

      // 本物のモデルが考えている間と同じように、少し待ってから本文を流す。
      // 待っている間に止められたら、そこまでの本文だけが残る。
      return Promise.resolve({
        events: mockTyping(reply, chunkSize, delayMs, signal),
        usage: Promise.resolve(usage),
      });
    },

    /**
     * モックの要約。中身は作れないので、要約が動いたことだけが分かる定型を返す。
     * モックは画面の確認用で、要約の中身を確かめるためのものではない（テストは偽のエンジンを渡す）。
     */
    complete({ prompt }) {
      return Promise.resolve(
        [
          "## Goal",
          `[mock] ${prompt.length} 文字を要約しました（モックのため中身は残しません）。`,
          "",
          "## Progress",
          "### In Progress",
          "- [ ] （モックのため、実際の要約は作りません）",
        ].join("\n"),
      );
    },
  };
}

/**
 * モックの「考えている時間」。文字数の分だけ少しずつ待ち、本文を区切って流す。
 * 本物の応答と同じく、画面へはターンの側が区切りごとに出す。
 */
async function* mockTyping(
  text: string,
  chunkSize: number,
  delayMs: number,
  signal: AbortSignal,
): AsyncGenerator<EngineEvent> {
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    if (signal.aborted) return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield { type: "text-delta", delta: text.slice(offset, offset + chunkSize) };
  }
}

/** モックの usage を作るための、モデルへ渡る本文の長さ。 */
function messageTextLength(message: ChatMessage): number {
  if (message.role === "user") return userContentForModel(message).length;
  if (message.parts === null) return 0;

  return message.parts.reduce((total, part) => (part.type === "text" ? total + part.text.length : total), 0);
}

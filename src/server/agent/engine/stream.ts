import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import { describeError, messageOf } from "../../../shared/errors";
import { splitToolName } from "../../../shared/tools";
import type { MessagePart, TokenUsage } from "../../../shared/types";
import { readToolOutput } from "../tool-output";
import type { EngineEvent, EngineStream } from "./index";

/** AI SDK のストリームを、画面と保存に必要な出来事だけに絞る。 */

/**
 * AI SDK のストリームを、画面と保存に必要な出来事だけに絞る。
 * 失敗はチャンクとして流れてくるので、ここで例外に戻す（黙って空の応答にしないため）。
 *
 * usage は最後のモデル呼び出し 1 回分を返す。ターン全体の合計は、
 * 文脈の大きさを測るのには使えない。ツールを使うターンでは呼び出しが何度もあるため、
 * 「最後のステップが送った文脈」が、次に送る文脈の大きさに一番近い。
 */
export function toEngineStream<TOOLS extends ToolSet>(
  chunks: AsyncIterable<TextStreamPart<TOOLS>>,
  reachedStepLimit: () => boolean,
): EngineStream {
  let lastStepUsage: TokenUsage | null = null;
  let resolveUsage: (usage: TokenUsage | null) => void = () => undefined;
  const usage = new Promise<TokenUsage | null>((resolve) => {
    resolveUsage = resolve;
  });

  async function* events(): AsyncGenerator<EngineEvent> {
    try {
      for await (const chunk of chunks) {
        if (chunk.type === "finish-step") {
          lastStepUsage = normalizeUsage(chunk.usage);
        }

        const event = toEngineEvent(chunk, reachedStepLimit);
        if (event !== null) yield event;
      }
    } finally {
      // 途中で止められても、待っている側を止めない（それまでに分かった値を返す）。
      resolveUsage(lastStepUsage);
    }
  }

  return { events: events(), usage };
}

function toEngineEvent<TOOLS extends ToolSet>(
  chunk: TextStreamPart<TOOLS>,
  reachedStepLimit: () => boolean,
): EngineEvent | null {
  switch (chunk.type) {
    case "text-delta":
      return { type: "text-delta", delta: chunk.text };

    case "tool-call": {
      const { server, tool } = splitToolName(chunk.toolName);
      return {
        type: "tool-call",
        part: { type: "tool-call", id: chunk.toolCallId, server, tool, args: chunk.input ?? {} },
      };
    }

    case "tool-result": {
      const { server, tool } = splitToolName(chunk.toolName);
      return {
        type: "tool-result",
        part: toolResultPart(chunk.toolCallId, server, tool, false, chunk.output),
      };
    }

    case "tool-error": {
      const { server, tool } = splitToolName(chunk.toolName);
      return {
        type: "tool-result",
        part: toolResultPart(chunk.toolCallId, server, tool, true, chunk.error),
      };
    }

    case "error":
      throw chunk.error instanceof Error ? chunk.error : new Error(describeError(chunk.error));

    case "finish":
      // ステップの上限まで使ったかどうか。黙って切れると、応答が途中で終わった理由が分からない。
      return reachedStepLimit() ? { type: "step-limit" } : null;

    default:
      return null;
  }
}

/**
 * ツールの結果を、保存する形にする。
 * 画像を返すツールは、その参照も一緒に残す（実体は画像の置き場にある）。
 */
function toolResultPart(
  id: string,
  server: string,
  tool: string,
  failed: boolean,
  value: unknown,
): Extract<MessagePart, { type: "tool-result" }> {
  // 失敗した呼び出しは、例外の message を本文にする（JSON の包装を見せない）。
  const output = failed
    ? { text: toolErrorMessage(value) ?? readToolOutput(value).text, images: [] }
    : readToolOutput(value);

  return {
    type: "tool-result",
    id,
    server,
    tool,
    failed,
    output: output.text,
    ...(output.images.length === 0 ? {} : { images: output.images }),
  };
}

/**
 * 失敗した呼び出しの戻り値から、モデルへ見せるエラー本文を取り出す。
 * 取り出せない形は null を返し、通常の本文の組み立てに任せる。
 */
function toolErrorMessage(value: unknown): string | null {
  return messageOf(value);
}

function normalizeUsage(raw: LanguageModelUsage): TokenUsage | null {
  const inputTokens = raw.inputTokens ?? 0;
  // 入力 0 は「報告されなかった」とみなす（空の文脈でモデルを呼ぶことはない）。
  // 0 のまま保存すると、文脈が実際より小さいものとして扱われ、畳む時を逃す。
  if (inputTokens === 0) return null;

  return {
    inputTokens,
    outputTokens: raw.outputTokens ?? 0,
    cachedInputTokens: raw.inputTokenDetails.cacheReadTokens ?? 0,
  };
}

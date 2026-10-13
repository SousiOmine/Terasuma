import { Agent } from "@mastra/core/agent";
import type { AppConfig } from "../config";
import type { ChatMessage, TokenUsage } from "../shared/types";
import { SYSTEM_PROMPT } from "./prompt";

/** モデルへ渡す会話 1 件分。role ごとに分けた union にしてある（Mastra 側の型がこの形を要求する）。 */
export type EngineMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

export type EngineStream = {
  textStream: AsyncIterable<string>;
  /** ストリーム終了時に解決する。取得できない場合は null。 */
  usage: Promise<TokenUsage | null>;
};

export type EngineInput = {
  /** セッションの保存済み履歴。seq 昇順で、末尾が今回のユーザー発言。 */
  history: readonly ChatMessage[];
  signal: AbortSignal;
};

/**
 * LLM 呼び出しのインタフェース。
 * Mastra に依存する部分はこのインタフェースの内側だけにあるので、実装の差し替え
 * （AI SDK の直接呼び出し、ツール対応、プロファイルごとのエージェント切り替え）は
 * ここを実装し直すだけで済む。
 */
export interface AgentEngine {
  readonly name: string;
  stream(input: EngineInput): Promise<EngineStream>;
}

export function createEngine(config: AppConfig): AgentEngine {
  if (config.engine === "mock") return createMockEngine();
  return createMastraEngine(config);
}

export function createMastraEngine(config: AppConfig): AgentEngine {
  // モデル一覧の定期再取得は常駐アプリには不要（既定で 1 時間ごとに通信する）。
  // Mastra が初期化時に読むため、Agent を作る前に必ず設定する。
  process.env.MASTRA_AUTO_REFRESH_PROVIDERS ??= "false";

  const agent = new Agent({
    id: "terasuma",
    name: "Terasuma",
    // system プロンプトはこの定数 1 つだけ。buildModelInput() と同じ前置きになる。
    instructions: SYSTEM_PROMPT,
    model: config.baseUrl
      ? { url: config.baseUrl, id: config.model, apiKey: config.apiKey ?? undefined }
      : config.model,
  });

  return {
    name: "mastra",
    async stream({ history, signal }) {
      const messages: EngineMessage[] = history.map((message) =>
        message.role === "user"
          ? { role: "user", content: message.content }
          : { role: "assistant", content: message.content },
      );

      const result = await agent.stream(messages, { abortSignal: signal });

      return {
        textStream: result.textStream,
        usage: result.usage.then(normalizeUsage, () => null),
      };
    },
  };
}

type RawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
};

function normalizeUsage(raw: RawUsage | undefined | null): TokenUsage | null {
  if (raw === undefined || raw === null) return null;
  return {
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    cachedInputTokens: raw.cachedInputTokens ?? 0,
  };
}

/**
 * API キー無しで UI とストリーミングを確認するためのモックの LLM。
 * TERASUMA_ENGINE=mock を明示したときだけ使われ、自動で選ばれることはない。
 */
export function createMockEngine(options: { chunkSize?: number; delayMs?: number } = {}): AgentEngine {
  const chunkSize = options.chunkSize ?? 6;
  const delayMs = options.delayMs ?? 12;

  return {
    name: "mock",
    stream({ history, signal }) {
      const lastUser = [...history].reverse().find((message) => message.role === "user");
      const userTurns = history.filter((message) => message.role === "user").length;

      const reply = [
        "[mock engine]",
        `これは偽の応答です。受け取った会話は ${history.length} 件（うちユーザー発言 ${userTurns} 件）。`,
        `直前の発言: ${lastUser?.content ?? "(なし)"}`,
      ].join("\n");

      // 数値は文字数から作った当てずっぽう。実際のキャッシュの値ではない。
      const usage: TokenUsage = {
        inputTokens: history.reduce((total, message) => total + message.content.length, 0),
        outputTokens: reply.length,
        cachedInputTokens: 0,
      };

      return Promise.resolve({
        textStream: chunkText(reply, chunkSize, delayMs, signal),
        usage: Promise.resolve(usage),
      });
    },
  };
}

async function* chunkText(
  text: string,
  chunkSize: number,
  delayMs: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  for (let index = 0; index < text.length; index += chunkSize) {
    if (signal.aborted) return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield text.slice(index, index + chunkSize);
  }
}

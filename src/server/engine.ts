import { Agent } from "@mastra/core/agent";
import { getProviderConfig } from "@mastra/core/llm";
import type { OpenAICompatibleConfig } from "@mastra/core/llm";
import type { AppConfig, ModelSettings } from "../config";
import { modelProvider, type ModelId } from "../shared/model";
import type { ChatMessage, TokenUsage } from "../shared/types";
import { SYSTEM_PROMPT } from "./prompt";
import { reasoningProviderOptions } from "./reasoning";

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

/** 設定を読む口。設定画面から変わるので、呼び出しのたびに読む。 */
export type SettingsReader = {
  read(): ModelSettings;
};

/** モデルの呼び出し方。カタログのプロバイダは Mastra のモデルルーターに任せ、独自エンドポイントは URL を渡す。 */
export type ResolvedModel =
  | { kind: "builtin"; id: ModelId; apiKey: string; reasoningEffort: string | null }
  | { kind: "endpoint"; id: ModelId; url: string; apiKey: string | null; reasoningEffort: string | null };

/** 呼び出せるかどうかの判定。呼び出せないときは理由を添える。 */
export type ModelResolution =
  | { ok: true; model: ResolvedModel }
  | { ok: false; detail: string };

/**
 * 既定のモデルとプロバイダの設定から、モデルの呼び出し方を決める。
 *
 * baseUrl を持つものは OpenAI 互換の独自エンドポイントとして URL を渡し、
 * 持たないものは models.dev のカタログのプロバイダとして Mastra のモデルルーターに任せる。
 * 思考強度はモデルごとの設定から取り出す。
 *
 * 設定が揃っていない状態は、モデルを呼ぶ前に理由付きで止める。
 * 既定値で埋め合わせると「設定したつもりで応答が来ない」状態になり、原因が分からなくなる。
 */
export function resolveModel(settings: ModelSettings): ModelResolution {
  const model = settings.model;
  if (model === null) {
    return { ok: false, detail: "既定のモデルが設定されていません（画面の「設定 > モデル」から追加してください）" };
  }

  const providerId = modelProvider(model);
  const provider = settings.providers[providerId];
  if (provider === undefined) {
    return {
      ok: false,
      detail: `既定のモデル ${model} のプロバイダ ${providerId} が設定されていません（画面の「設定 > モデル」から追加してください）`,
    };
  }

  const reasoningEffort = settings.modelOptions[model]?.reasoningEffort ?? null;

  // baseUrl があるものは OpenAI 互換の独自エンドポイント。
  if (provider.baseUrl !== undefined) {
    return {
      ok: true,
      model: {
        kind: "endpoint",
        id: model,
        url: provider.baseUrl,
        apiKey: provider.apiKey ?? null,
        reasoningEffort,
      },
    };
  }

  if (provider.apiKey === undefined) {
    return { ok: false, detail: `プロバイダ ${providerId} の API キーが設定されていません` };
  }

  // 接続先を自分で決めないものは、Mastra のモデルルーターが URL を解決できる必要がある。
  if (getProviderConfig(providerId) === undefined) {
    return {
      ok: false,
      detail: `プロバイダ ${providerId} を models.dev のカタログに見つけられません（画面の「設定 > モデル」から選び直してください）`,
    };
  }

  return { ok: true, model: { kind: "builtin", id: model, apiKey: provider.apiKey, reasoningEffort } };
}

export function createEngine(options: { config: AppConfig; settings: SettingsReader }): AgentEngine {
  if (options.config.engine === "mock") return createMockEngine();
  return createMastraEngine(options.settings);
}

export function createMastraEngine(settings: SettingsReader): AgentEngine {
  // モデル一覧の定期再取得は常駐アプリには不要（既定で 1 時間ごとに通信する）。
  // Mastra が初期化時に読むため、Agent を作る前に必ず設定する。
  process.env.MASTRA_AUTO_REFRESH_PROVIDERS ??= "false";

  let cached: { key: string; agent: Agent } | null = null;

  /** 設定が変わったら作り直す。同じ設定の間は使い回す。思考強度は呼び出しごとに渡すので鍵に含めない。 */
  function agentFor(model: ResolvedModel): Agent {
    const key = JSON.stringify(toModelConfig(model));
    if (cached !== null && cached.key === key) return cached.agent;

    const agent = new Agent({
      id: "terasuma",
      name: "Terasuma",
      // system プロンプトはこの定数 1 つだけ。buildModelInput() と同じ前置きになる。
      instructions: SYSTEM_PROMPT,
      model: toModelConfig(model),
    });

    cached = { key, agent };
    return agent;
  }

  return {
    name: "mastra",
    async stream({ history, signal }) {
      // 設定は設定画面から変わるので、ターンのたびに読み直す。
      const resolution = resolveModel(settings.read());
      if (!resolution.ok) throw new Error(resolution.detail);

      const messages: EngineMessage[] = history.map((message) =>
        message.role === "user"
          ? { role: "user", content: message.content }
          : { role: "assistant", content: message.content },
      );

      // 思考強度はプロバイダごとに渡し方が違うので、ここで組み立てて呼び出しごとに渡す。
      const providerOptions = reasoningProviderOptions(
        modelProvider(resolution.model.id),
        resolution.model.reasoningEffort,
      );

      const result = await agentFor(resolution.model).stream(messages, {
        abortSignal: signal,
        ...(providerOptions === null ? {} : { providerOptions }),
      });

      return {
        textStream: result.textStream,
        usage: result.usage.then(normalizeUsage, () => null),
      };
    },
  };
}

/** Mastra（AI SDK）へ渡すモデルの指定。 */
function toModelConfig(model: ResolvedModel): OpenAICompatibleConfig {
  if (model.kind === "endpoint") {
    return { id: model.id, url: model.url, apiKey: model.apiKey ?? undefined };
  }
  return { id: model.id, apiKey: model.apiKey };
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

import { Agent } from "@mastra/core/agent";
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import { getProviderConfig } from "@mastra/core/llm";
import type { OpenAICompatibleConfig } from "@mastra/core/llm";
import type { ChunkType } from "@mastra/core/stream";
import type { AppConfig, ModelSettings } from "../config";
import { modelProvider, type ModelId } from "../shared/model";
import type { ChatMessage, MessagePart, TokenUsage } from "../shared/types";
import type { ImageRef } from "../shared/types";
import type { ComputerToolset } from "./computer";
import type { ImageStore } from "./images";
import type { McpToolset } from "./mcp";
import { SYSTEM_PROMPT, toModelMessages } from "./prompt";
import { reasoningProviderOptions } from "./reasoning";

/** モデルから流れてくる出来事。画面へ流す単位でもある。 */
export type EngineEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; part: Extract<MessagePart, { type: "tool-call" }> }
  | { type: "tool-result"; part: Extract<MessagePart, { type: "tool-result" }> };

export type EngineStream = {
  events: AsyncIterable<EngineEvent>;
  /** ストリーム終了時に解決する。取得できない場合は null。 */
  usage: Promise<TokenUsage | null>;
};

export type EngineInput = {
  /** セッションの保存済み履歴。seq 昇順で、末尾が今回のユーザー発言。 */
  history: readonly ChatMessage[];
  signal: AbortSignal;
  /** このターンのセッション。コンテナの引き受け（computer_ask_user）をこの単位で待つ。 */
  sessionId: string;
};

/** モデルへ渡すツールの供給元。接続を持たないテストでもここを差し替えれば済む。 */
export type ToolsetProvider = {
  toolset(): Promise<McpToolset>;
};

/**
 * コンテナのツールの供給元。ターンの対象セッションと、
 * ツールが撮った画像を受け取る口を渡す。
 */
export type ComputerToolsetProvider = {
  toolset(input: { sessionId: string; onImage: (image: ImageRef) => void }): Promise<ComputerToolset>;
};

/**
 * LLM 呼び出しのインタフェース。
 * Mastra に依存する部分はこのインタフェースの内側だけにあるので、実装の差し替え
 * （AI SDK の直接呼び出し、承認フローの追加、プロファイルごとのエージェント切り替え）は
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

export function createEngine(options: {
  config: AppConfig;
  settings: SettingsReader;
  mcp: ToolsetProvider;
  computer: ComputerToolsetProvider;
  /** 撮った画像の置き場。履歴から画像を読み直してモデルへ渡す。 */
  images: ImageStore;
}): AgentEngine {
  if (options.config.engine === "mock") return createMockEngine();
  return createMastraEngine(options.settings, options.mcp, options.computer, options.images);
}

/**
 * 1 ターンでモデルを呼ぶ回数の上限。
 * 画面を見て押して、また見て確かめるような操作は何ステップにもなる。
 * 依存側の既定値に任せると、上げ下げのつもりがなくても変わってしまうので、ここで決める。
 */
const MAX_STEPS_PER_TURN = 5;

export function createMastraEngine(
  settings: SettingsReader,
  mcp: ToolsetProvider,
  computer: ComputerToolsetProvider,
  images: ImageStore,
): AgentEngine {
  // モデル一覧の定期再取得は常駐アプリには不要（既定で 1 時間ごとに通信する）。
  // Mastra が初期化時に読むため、Agent を作る前に必ず設定する。
  process.env.MASTRA_AUTO_REFRESH_PROVIDERS ??= "false";

  let cached: { key: string; agent: Agent } | null = null;

  /** 設定が変わったら作り直す。同じ設定の間は使い回す。思考強度とツールは呼び出しごとに渡す。 */
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
    async stream({ history, signal, sessionId }) {
      // 設定は設定画面から変わるので、ターンのたびに読み直す。
      const resolution = resolveModel(settings.read());
      if (!resolution.ok) throw new Error(resolution.detail);

      // 保存済み履歴をそのまま渡す。要約も並べ替えもしない
      // （プロンプトキャッシュが当たり続けるようにするため）。
      const messages = toModelMessages(history, images);

      // 思考強度はプロバイダごとに渡し方が違うので、ここで組み立てて呼び出しごとに渡す。
      const providerOptions = reasoningProviderOptions(
        modelProvider(resolution.model.id),
        resolution.model.reasoningEffort,
      );

      // このターンで撮った画像。次のステップの直前に user メッセージとして足す。
      const capturedImages: ImageRef[] = [];

      // MCP とコンテナのツールは呼び出しごとに渡す
      // （設定画面でサーバーを足しても、コンテナを止めても Agent を作り直さずに済む）。
      const [mcpTools, computerTools] = await Promise.all([
        mcp.toolset(),
        computer.toolset({ sessionId, onImage: (image) => capturedImages.push(image) }),
      ]);
      const tools = { ...mcpTools, ...computerTools };

      const result = await agentFor(resolution.model).stream(messages, {
        abortSignal: signal,
        maxSteps: MAX_STEPS_PER_TURN,
        ...(providerOptions === null ? {} : { providerOptions }),
        ...(Object.keys(tools).length === 0 ? {} : { toolsets: { tools } }),
        // tool の本文に画像を置けるプロバイダが無い（OpenAI 互換は文字列へ潰す）。
        // ステップの直前に user メッセージとして足し、どの呼び出しの画像かを本文で示す。
        prepareStep: ({ messages: current }) => {
          if (capturedImages.length === 0) return undefined;

          const added = capturedImages.splice(0).flatMap((image) => stepImageMessage(image, images));
          if (added.length === 0) return undefined;

          return { messages: [...current, ...added] };
        },
      });

      return {
        events: toEngineEvents(result.fullStream),
        usage: result.usage.then(normalizeUsage, () => null),
      };
    },
  };
}

/**
 * Mastra のストリームを、画面と保存に必要な出来事だけに絞る。
 * 失敗はチャンクとして流れてくるので、ここで例外に戻す（黙って空の応答にしないため）。
 */
async function* toEngineEvents(chunks: AsyncIterable<ChunkType>): AsyncGenerator<EngineEvent> {
  for await (const chunk of chunks) {
    const event = toEngineEvent(chunk);
    if (event !== null) yield event;
  }
}

function toEngineEvent(chunk: ChunkType): EngineEvent | null {
  switch (chunk.type) {
    case "text-delta":
      return { type: "text-delta", delta: chunk.payload.text };

    case "tool-call": {
      const { server, tool } = splitToolName(chunk.payload.toolName);
      return {
        type: "tool-call",
        part: { type: "tool-call", id: chunk.payload.toolCallId, server, tool, args: chunk.payload.args ?? {} },
      };
    }

    case "tool-result": {
      const { server, tool } = splitToolName(chunk.payload.toolName);
      return {
        type: "tool-result",
        part: toolResultPart(
          chunk.payload.toolCallId,
          server,
          tool,
          chunk.payload.isError === true,
          chunk.payload.result,
        ),
      };
    }

    case "tool-error": {
      const { server, tool } = splitToolName(chunk.payload.toolName);
      return {
        type: "tool-result",
        part: toolResultPart(chunk.payload.toolCallId, server, tool, true, chunk.payload.error),
      };
    }

    case "error":
      throw chunk.payload.error instanceof Error ? chunk.payload.error : new Error(describe(chunk.payload.error));

    default:
      return null;
  }
}

/**
 * "<サーバー id>_<ツール名>" を分ける。
 * サーバー id に "_" は使えないので、最初の区切りで必ず確定する。
 */
function splitToolName(name: string): { server: string; tool: string } {
  const boundary = name.indexOf("_");
  if (boundary === -1) return { server: "", tool: name };
  return { server: name.slice(0, boundary), tool: name.slice(boundary + 1) };
}

/**
 * ツールの結果を、保存する形にする。
 * コンテナのツールは画像を返すことがあるので、その参照も一緒に持たせる。
 */
function toolResultPart(
  id: string,
  server: string,
  tool: string,
  failed: boolean,
  value: unknown,
): Extract<MessagePart, { type: "tool-result" }> {
  const image = readImageRef(value);

  return {
    type: "tool-result",
    id,
    server,
    tool,
    failed,
    output: toolOutputText(value),
    ...(image === undefined ? {} : { image }),
  };
}

/**
 * ツールの戻り値から画像の参照を取り出す。
 * コンテナのツールが返す形（{ text, image }）だけを扱い、それ以外は画像なしとして扱う。
 */
function readImageRef(value: unknown): ImageRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const image = (value as { image?: unknown }).image;
  if (typeof image !== "object" || image === null) return undefined;

  const { sha256, mime, width, height } = image as Record<string, unknown>;
  if (typeof sha256 !== "string" || typeof mime !== "string") return undefined;
  if (typeof width !== "number" || typeof height !== "number") return undefined;

  return { sha256, mime, width, height };
}

/** ツールの戻り値を、モデルと画面に見せる文字列にする。 */
function toolOutputText(value: unknown): string {
  // コンテナのツールは本文を text に入れて返す。
  if (typeof value === "object" && value !== null) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }

  const text = mcpContentText(value);
  if (text !== null) return text;

  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

/**
 * MCP の結果（content ブロック）がそのまま入っている場合に、そのテキストをまとめる。
 * 構造化された値しか無い場合は null を返し、呼び出し側が JSON として見せる。
 */
function mcpContentText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;

  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") texts.push(entry.text);
  }
  return texts.length === 0 ? null : texts.join("\n");
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
        events: chunkText(reply, chunkSize, delayMs, signal),
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
): AsyncGenerator<EngineEvent> {
  for (let index = 0; index < text.length; index += chunkSize) {
    if (signal.aborted) return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield { type: "text-delta", delta: text.slice(index, index + chunkSize) };
  }
}

/**
 * 撮った画像を、Mastra の 1 ターン内で次のステップへ渡せる形にする。
 *
 * tool の本文に画像を置けるプロバイダが無い（OpenAI 互換は content を文字列へ潰す）ため、
 * ツールの結果の直後に user メッセージとして足す。どの呼び出しの画像かは本文に書く。
 */
function stepImageMessage(image: ImageRef, images: ImageStore): MastraDBMessage[] {
  const data = images.read(image);
  if (data === null) return [];

  return [
    {
      id: crypto.randomUUID(),
      role: "user",
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [
          { type: "text", text: "(screen image from the computer_screenshot call)" },
          { type: "file", mimeType: image.mime, data: Buffer.from(data).toString("base64") },
        ],
      },
    },
  ];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { generateText, stepCountIs, streamText } from "ai";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type { AppConfig, ModelSettings } from "../config";
import type { ReplyLanguage } from "../shared/language";
import { modelProvider } from "../shared/model";
import type { MessagePart, TokenUsage } from "../shared/types";
import type { ImageRef } from "../shared/types";
import type { CodingToolset } from "./coding";
import type { ComputerToolset } from "./computer";
import type { ImageStore } from "./images";
import type { McpToolset } from "./mcp";
import { catalogProvider, type CatalogSnapshot } from "./models-dev";
import { SYSTEM_PROMPT, screenMessage, toModelMessages, type TeraContext } from "./prompt";
import { catalogRoute, createLanguageModel, type ResolvedModel } from "./provider-registry";
import { reasoningProviderOptions } from "./reasoning";
import { describeError } from "../shared/errors";

/** モデルから流れてくる出来事。画面へ流す単位でもある。 */
export type EngineEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; part: Extract<MessagePart, { type: "tool-call" }> }
  | { type: "tool-result"; part: Extract<MessagePart, { type: "tool-result" }> }
  /** 1 ターンのステップの上限で打ち切られた。 */
  | { type: "step-limit" };

export type EngineStream = {
  events: AsyncIterable<EngineEvent>;
  /**
   * 最後のモデル呼び出し 1 回分のトークン消費。ストリーム終了時に解決する。
   * 取得できない場合は null。
   */
  usage: Promise<TokenUsage | null>;
};

export type EngineInput = {
  /** Tera の文脈（畳んだ要約と、まだ畳んでいない生の履歴）。末尾が今回のユーザー発言。 */
  context: TeraContext;
  signal: AbortSignal;
  /** このターンの Tera。コンテナの引き受け（computer_ask_user）をこの単位で待つ。 */
  teraId: string;
  /** 返事を書く言語。設定画面の言語を使い、ユーザープロンプトの末尾で指示する。 */
  replyLanguage: ReplyLanguage;
};

/**
 * ツールを使わない 1 回の呼び出し。過去の対話の要約（圧縮）が使う。
 * 会話のターンとは別に走るので、ターンの中断（停止）には巻き込まれない。
 */
export type CompleteInput = {
  /** この呼び出しだけの system プロンプト。 */
  instructions: string;
  prompt: string;
  /** 要約の期限。過ぎたら打ち切る。 */
  signal: AbortSignal;
  /** 出力の上限。要約が際限なく長くならないようにする。 */
  maxOutputTokens: number;
};

/** モデルへ渡すツールの供給元。接続を持たないテストでもここを差し替えれば済む。 */
export type ToolsetProvider = {
  toolset(): Promise<McpToolset>;
};

/**
 * コンテナのツールの供給元。ターンの対象の Tera と、
 * ツールが撮った画像を受け取る口を渡す。
 */
export type ComputerToolsetProvider = {
  toolset(input: { teraId: string; onImage: (image: ImageRef) => void }): Promise<ComputerToolset>;
};

/**
 * LLM 呼び出しのインタフェース。
 * AI SDK に依存する部分はこのインタフェースの内側だけにあるので、実装の差し替え
 * （承認フローの追加、プロファイルごとのエージェント切り替え）はここを実装し直すだけで済む。
 */
export interface AgentEngine {
  readonly name: string;
  stream(input: EngineInput): Promise<EngineStream>;
  /** ツールを使わない 1 回の生成。過去の対話の要約に使う。 */
  complete(input: CompleteInput): Promise<string>;
}

/** 設定を読む口。設定画面から変わるので、呼び出しのたびに読む。 */
export type SettingsReader = {
  read(): ModelSettings;
};

/** カタログを読む口。カタログは起動後に取り直すので、呼び出しのたびに読む。 */
export type CatalogReader = {
  snapshot(): CatalogSnapshot | null;
};

/** 呼び出せるかどうかの判定。呼び出せないときは理由を添える。 */
export type ModelResolution =
  | { ok: true; model: ResolvedModel }
  | { ok: false; detail: string };

/**
 * 既定のモデルとプロバイダの設定から、モデルの呼び出し方を決める。
 *
 * baseUrl を持つものは OpenAI 互換の独自エンドポイントとして、その URL を使う。
 * 持たないものは models.dev のカタログのプロバイダとして、npm（使うパッケージ）と
 * api（接続先）から呼び出し方を決める。
 * 思考強度はモデルごとの設定から取り出す。
 *
 * 設定が揃っていない状態は、モデルを呼ぶ前に理由付きで止める。
 * 既定値で埋め合わせると「設定したつもりで応答が来ない」状態になり、原因が分からなくなる。
 */
export function resolveModel(settings: ModelSettings, snapshot: CatalogSnapshot | null): ModelResolution {
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
        id: model,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? null,
        provider: { id: providerId, kind: "openai-compatible", optionKey: providerId },
        reasoningEffort,
      },
    };
  }

  if (provider.apiKey === undefined) {
    return { ok: false, detail: `プロバイダ ${providerId} の API キーが設定されていません` };
  }

  if (snapshot === null) {
    return {
      ok: false,
      detail: "models.dev のカタログをまだ読めていません（少し待ってから、もう一度送ってください）",
    };
  }

  const entry = catalogProvider(snapshot, providerId);
  if (entry === null) {
    return {
      ok: false,
      detail: `プロバイダ ${providerId} を models.dev のカタログに見つけられません（画面の「設定 > モデル」から選び直してください）`,
    };
  }

  const route = catalogRoute(entry);
  if (route === null) {
    return {
      ok: false,
      detail: `プロバイダ ${providerId} をこのアプリから呼び出せません（対応していないか、接続先が分かりません。baseUrl を設定してください）`,
    };
  }

  return {
    ok: true,
    model: {
      id: model,
      baseUrl: route.baseUrl,
      apiKey: provider.apiKey,
      provider: route.spec,
      reasoningEffort,
    },
  };
}

export function createEngine(options: {
  config: AppConfig;
  settings: SettingsReader;
  mcp: ToolsetProvider;
  computer: ComputerToolsetProvider;
  /** コンテナのファイルとシェルのツール。ターンごとに変わらないので、そのまま渡す。 */
  coding: CodingToolset;
  /** 撮った画像の置き場。履歴から画像を読み直してモデルへ渡す。 */
  images: ImageStore;
  /** models.dev のカタログ。プロバイダの呼び出し方を決めるのに使う。 */
  catalog: CatalogReader;
}): AgentEngine {
  if (options.config.engine === "mock") return createMockEngine();
  return createAiSdkEngine({
    settings: options.settings,
    mcp: options.mcp,
    computer: options.computer,
    coding: options.coding,
    images: options.images,
    catalog: options.catalog,
  });
}

/**
 * 1 ターンでモデルを呼ぶ回数の上限。
 *
 * ファイルを読み、直し、実行して確かめるようなコーディングの作業は何十ステップにもなる。
 * 5 では 1 回の依頼で終わらないので、実質的に止まらない高さにしてある。
 * それでも 0 にはしない。ツールの呼び出しが噛み合わずに繰り返されたとき、
 * 際限なくモデルを呼び続けて課金が止まらなくなるのを防ぐため、最後の歯止めは残す。
 * 依存側の既定値に任せると、こちらの意図と関係なく変わってしまうので、ここで決める。
 */
const MAX_STEPS_PER_TURN = 500;

export type AiSdkEngineOptions = {
  settings: SettingsReader;
  mcp: ToolsetProvider;
  computer: ComputerToolsetProvider;
  /** コンテナのファイルとシェルのツール。 */
  coding: CodingToolset;
  images: ImageStore;
  /** models.dev のカタログ。プロバイダの呼び出し方を決めるのに使う。 */
  catalog: CatalogReader;
};

export function createAiSdkEngine(options: AiSdkEngineOptions): AgentEngine {
  const { settings, mcp, computer, coding, images, catalog } = options;

  /** 設定とカタログから、今回のモデルを決める。呼び出しのたびに読み直す。 */
  function resolve(): ResolvedModel {
    const resolution = resolveModel(settings.read(), catalog.snapshot());
    if (!resolution.ok) throw new Error(resolution.detail);
    return resolution.model;
  }

  return {
    name: "ai-sdk",
    async stream({ context, signal, teraId, replyLanguage }) {
      const model = resolve();

      // 畳んだ要約を先頭に、生の履歴をその後ろに置く。生の履歴には要約も並べ替えもしない
      // （プロンプトキャッシュが当たり続けるようにするため）。
      const messages = toModelMessages(context, images, replyLanguage);

      // 思考強度はプロバイダごとに渡し方が違うので、ここで組み立てて呼び出しごとに渡す。
      const providerOptions = reasoningProviderOptions(model.provider, model.reasoningEffort);

      // このターンで撮った画像。次のステップの直前に user メッセージとして足す。
      const capturedImages: ImageRef[] = [];

      // MCP とコンテナのツールは呼び出しごとに渡す
      // （設定画面でサーバーを足しても、コンテナを止めても作り直さずに済む）。
      const [mcpTools, computerTools] = await Promise.all([
        mcp.toolset(),
        computer.toolset({ teraId, onImage: (image) => capturedImages.push(image) }),
      ]);
      const tools: ToolSet = { ...mcpTools, ...computerTools, ...coding };

      // 上限で止まったかどうかを、finish のときに知れるようにする。
      const withinLimit = stepCountIs(MAX_STEPS_PER_TURN);
      let reachedStepLimit = false;

      const result = streamText({
        model: createLanguageModel(model),
        instructions: SYSTEM_PROMPT,
        messages,
        abortSignal: signal,
        ...(Object.keys(tools).length === 0 ? {} : { tools }),
        stopWhen: (options) => {
          const stop = withinLimit(options);
          if (stop) reachedStepLimit = true;
          return stop;
        },
        ...(providerOptions === null ? {} : { providerOptions }),
        // tool の本文に画像を置けるプロバイダが無い（OpenAI 互換は文字列へ潰す）。
        // ステップの直前に user メッセージとして足し、どの呼び出しの画像かを本文で示す。
        prepareStep: ({ messages: current }) => {
          if (capturedImages.length === 0) return undefined;

          const added = capturedImages.splice(0).flatMap((image) => screenMessage(image, images));
          if (added.length === 0) return undefined;

          return { messages: [...current, ...added] };
        },
      });

      return toEngineStream(result.fullStream, () => reachedStepLimit);
    },

    /**
     * ツールを使わない 1 回の生成（要約）。
     * 指示もプロンプトも呼び出しごとに変わるので、その場で組み立てる。
     */
    async complete({ instructions, prompt, signal, maxOutputTokens }) {
      const result = await generateText({
        model: createLanguageModel(resolve()),
        instructions,
        prompt,
        abortSignal: signal,
        maxOutputTokens,
      });
      return result.text;
    },
  };
}

/**
 * AI SDK のストリームを、画面と保存に必要な出来事だけに絞る。
 * 失敗はチャンクとして流れてくるので、ここで例外に戻す（黙って空の応答にしないため）。
 *
 * usage は最後のモデル呼び出し 1 回分を返す。ターン全体の合計は、
 * 文脈の大きさを測るのには使えない。ツールを使うターンでは呼び出しが何度もあるため、
 * 「最後のステップが送った文脈」が、次に送る文脈の大きさに一番近い。
 */
function toEngineStream<TOOLS extends ToolSet>(
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
    output: toolOutputText(value, failed),
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

/**
 * 失敗した呼び出しの戻り値から、モデルへ見せるエラー本文を取り出す。
 * 取り出せない形（MCP の content など）は null を返し、通常の本文の組み立てに任せる。
 */
function toolErrorMessage(value: unknown): string | null {
  if (value instanceof Error) return value.message;
  if (typeof value !== "object" || value === null) return null;

  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

/** ツールの戻り値を、モデルと画面に見せる文字列にする。 */
function toolOutputText(value: unknown, failed = false): string {
  if (failed) {
    const message = toolErrorMessage(value);
    if (message !== null) return message;
  }

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
        inputTokens: context.messages.reduce((total, message) => total + message.content.length, 0),
        outputTokens: reply.length,
        cachedInputTokens: 0,
      };

      return Promise.resolve({
        events: chunkText(reply, chunkSize, delayMs, signal),
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

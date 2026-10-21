import { generateText, stepCountIs, streamText } from "ai";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type { AppConfig } from "../../config";
import type { ModelSettings } from "../data/settings-schema";
import type { ReplyLanguage } from "../../shared/language";
import type { ChatMessage, MessagePart, OutgoingMessage, TokenUsage } from "../../shared/types";
import type { CodingToolset } from "./tools/coding";
import type { ComputerToolset } from "./tools/computer";
import type { MessagingToolset } from "./tools/messaging";
import type { ImageStore } from "../computer/images";
import type { McpToolset } from "../mcp/manager";
import type { CatalogSnapshot } from "../provider/catalog";
import { createLanguageModel } from "../provider/adapters";
import { toolResultTakesImages } from "../provider/kinds";
import { reasoningProviderOptions } from "../provider/reasoning";
import { type ResolvedModel, resolveModel } from "../provider/routing";
import { imagesMessage, SYSTEM_PROMPT, toModelMessages, type PendingImages, type TeraContext } from "./prompt";
import { userContentForModel } from "./model-content";
import { readStoredImages, readToolOutput, toolResultOutput } from "./tool-output";
import { describeError } from "../../shared/errors";
import { splitToolName } from "../../shared/tools";

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
  /**
   * エージェントがユーザーへメッセージを送る口。chat_send ツールから呼ばれる。
   * ターンの外へ出るのはこの口だけで、モデルの本文はここを通らない。
   */
  send: (message: OutgoingMessage) => void;
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
 * コンテナのツールの供給元。ターンの対象の Tera を渡す。
 */
export type ComputerToolsetProvider = {
  toolset(input: { teraId: string }): Promise<ComputerToolset>;
};

/**
 * ユーザーへメッセージを送るツールの供給元。
 * 送信の口はターンごとに差し替わるので、呼び出しのたびに渡す。
 */
export type MessagingToolsetProvider = {
  toolset(input: { send: (message: OutgoingMessage) => void }): MessagingToolset;
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

export function createEngine(options: {
  config: AppConfig;
  settings: SettingsReader;
  mcp: ToolsetProvider;
  computer: ComputerToolsetProvider;
  /** ユーザーへメッセージを送るツール。 */
  messaging: MessagingToolsetProvider;
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
    messaging: options.messaging,
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
  /** ユーザーへメッセージを送るツール。 */
  messaging: MessagingToolsetProvider;
  /** コンテナのファイルとシェルのツール。 */
  coding: CodingToolset;
  images: ImageStore;
  /** models.dev のカタログ。プロバイダの呼び出し方を決めるのに使う。 */
  catalog: CatalogReader;
};

export function createAiSdkEngine(options: AiSdkEngineOptions): AgentEngine {
  const { settings, mcp, computer, messaging, coding, images, catalog } = options;

  /** 設定とカタログから、今回のモデルを決める。呼び出しのたびに読み直す。 */
  function resolve(): ResolvedModel {
    const resolution = resolveModel(settings.read(), catalog.snapshot());
    if (!resolution.ok) throw new Error(resolution.detail);
    return resolution.model;
  }

  return {
    name: "ai-sdk",
    async stream({ context, signal, teraId, replyLanguage, send }) {
      const model = resolve();

      // ツールの結果に画像を置けるかはプロバイダ次第。置けない場合は user メッセージで渡す。
      const toolResultImages = toolResultTakesImages(model.provider.kind);

      // 畳んだ要約を先頭に、生の履歴をその後ろに置く。生の履歴には要約も並べ替えもしない
      // （プロンプトキャッシュが当たり続けるようにするため）。
      const messages = toModelMessages(context, images, replyLanguage, { toolResultImages });

      // 思考強度はプロバイダごとに渡し方が違うので、ここで組み立てて呼び出しごとに渡す。
      const providerOptions = reasoningProviderOptions(model.provider, model.reasoningEffort);

      // 画像を結果に置けないプロバイダのために、このターンで届いた画像を集める。
      // 次のステップの直前に user メッセージとして足す。
      const pendingImages: PendingImages[] = [];

      // MCP とコンテナのツール、それに送信のツールは呼び出しごとに渡す
      // （設定画面でサーバーを足しても、コンテナを止めても作り直さずに済む）。
      const [mcpTools, computerTools] = await Promise.all([mcp.toolset(), computer.toolset({ teraId })]);
      const messageTools = messaging.toolset({ send });
      const tools = withToolModelOutput(
        { ...mcpTools, ...computerTools, ...coding, ...messageTools },
        {
          includeImages: toolResultImages,
          images,
          onImages: (entry) => pendingImages.push(entry),
        },
      );

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
        // 画像を結果に置けないプロバイダでは、結果の直後に user メッセージとして足し、
        // どの呼び出しの画像かを本文で示す（プロバイダの役割の並びも壊さない）。
        ...(toolResultImages
          ? {}
          : {
              prepareStep: ({ messages: current }) => {
                if (pendingImages.length === 0) return undefined;

                const message = imagesMessage(pendingImages.splice(0), images);
                return message === null ? undefined : { messages: [...current, message] };
              },
            }),
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
 * すべてのツールの結果を、モデルへ渡す形（本文 + 画像）に揃える。
 *
 * ツールの戻り値は文字列か { text, images } なので、そのまま渡すとオブジェクトが
 * JSON としてモデルに見えてしまう。ここで本文だけに開き、画像を置けるプロバイダには
 * content の file 部品として一緒に渡す。置けないプロバイダには本文だけを渡し、
 * 画像は prepareStep が user メッセージとして足す。
 */
function withToolModelOutput(
  tools: ToolSet,
  options: {
    includeImages: boolean;
    images: ImageStore;
    /** 画像を結果に置けないときに、結果の直後の user メッセージへ回すために集める。 */
    onImages?: (entry: PendingImages) => void;
  },
): ToolSet {
  // 同じ呼び出しで toModelOutput が複数回呼ばれても、画像を二重に集めない。
  const collected = new Set<string>();

  const wrapped: ToolSet = {};

  for (const [name, definition] of Object.entries(tools)) {
    wrapped[name] = {
      ...definition,
      toModelOutput: ({ toolCallId, output }: { toolCallId: string; output: unknown }) => {
        const { text, images } = readToolOutput(output);

        // 画像を結果に置けないプロバイダでは、結果の直後の user メッセージとして渡す。
        // toModelOutput はステップの応答を組み立てるとき（prepareStep より前）に呼ばれる。
        if (!options.includeImages && images.length > 0 && !collected.has(toolCallId)) {
          collected.add(toolCallId);
          options.onImages?.({ label: `${name} call`, images });
        }

        return toolResultOutput({
          text,
          images: readStoredImages(images, options.images),
          failed: false,
          includeImages: options.includeImages,
        });
      },
    };
  }

  return wrapped;
}

/**
 * 失敗した呼び出しの戻り値から、モデルへ見せるエラー本文を取り出す。
 * 取り出せない形は null を返し、通常の本文の組み立てに任せる。
 */
function toolErrorMessage(value: unknown): string | null {
  if (value instanceof Error) return value.message;
  if (typeof value !== "object" || value === null) return null;

  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
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
    stream({ context, signal, replyLanguage, send }) {
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

      // 本物のモデルが考えている間と同じように、少し待ってから 1 件だけ送る。
      // 待っている間に止められたら、何も送らずに終わる。
      return Promise.resolve({
        events: mockTyping(reply.length, chunkSize, delayMs, signal, () => send({ text: reply, attachments: [] })),
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
 * モックの「考えている時間」。文字数の分だけ少しずつ待ち、終わったら 1 件送る。
 * 送る内容は少しずつ出さない（本物の応答も、いまはメッセージ単位でしか出ない）。
 */
async function* mockTyping(
  length: number,
  chunkSize: number,
  delayMs: number,
  signal: AbortSignal,
  send: () => void,
): AsyncGenerator<EngineEvent> {
  const steps = Math.ceil(length / chunkSize);
  for (let step = 0; step < steps; step += 1) {
    if (signal.aborted) return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (signal.aborted) return;

  send();
}

/** モックの usage を作るための、モデルへ渡る本文の長さ。 */
function messageTextLength(message: ChatMessage): number {
  if (message.role === "user") return userContentForModel(message).length;
  if (message.parts === null) return 0;

  return message.parts.reduce((total, part) => (part.type === "text" ? total + part.text.length : total), 0);
}

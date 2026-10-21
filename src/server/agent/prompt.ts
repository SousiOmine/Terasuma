import type { ModelMessage } from "ai";
import type { ReplyLanguage } from "../../shared/language";
import type { ChatMessage, ImageRef, MessagePart } from "../../shared/types";
import { toolNameFor } from "../../shared/tools";
import type { ImageReader } from "../computer/images";
import { userContentForModel } from "./model-content";
import { SKILL_CATALOG } from "./skills";
import { readStoredImages, toolResultOutput, type StoredImages } from "./tool-output";

/**
 * モデルへ渡す system プロンプト。
 *
 * プロンプトキャッシュは、リクエストの先頭が前回と一致するほど当たる。
 * ここには絶対に可変値を入れない。日時・ユーザー名・件数・ファイル一覧などを混ぜると、
 * 先頭が一致しなくなり、毎回キャッシュが当たらなくなる。
 * 可変の情報をモデルへ渡したくなったら、履歴の末尾（最後の user メッセージの後ろ）に置くこと。
 * 畳んだ要約（TeraContext）は、この定数ではなく先頭の user メッセージとして渡す。
 */
export const SYSTEM_PROMPT = [
  "You are Terasuma, a general-purpose assistant running on the user's own machine.",
  "You talk with the user in a chat app.",
  "Your text output is shown to the user as chat messages. Write your reply as normal text; keep it concise and readable.",
  "Use the chat_attach tool only to show an image or file: pass paths inside the computer, or set screenshot to true. It cannot send text.",
  "Images become photos and other files become downloads.",
  "Always follow the reply-language instruction at the end of the conversation, and write your reply in that language.",
  "The read, write, edit, and bash tools run inside the Debian desktop container that you operate.",
  "Relative paths in read, write, edit, and chat_attach, and the working directory of bash, are /home/agent. Absolute paths are container paths.",
  "Use read to examine a file before changing it. Use edit for targeted changes; use write only for new files or complete rewrites.",
  "MCP server tools and the computer_ tools that drive the container's screen are not in your tool list.",
  "Find them with tool_search (omit the query to list every available tool by name), then run one with tool_call, using the exact name and the arguments its search result describes.",
  "Skills (load one with the skill tool before starting work that matches it):",
  SKILL_CATALOG,
].join("\n");

/**
 * モデルへ渡す文脈。system プロンプトの後ろに、畳んだ要約と生の履歴をこの順で置く。
 *
 * 要約は古いやり取りを畳んだもの、生の履歴はまだ畳んでいない直近のやり取り。
 * 合わせて 1 本の会話になり、続きは常に末尾へ足される。
 */
export type TeraContext = {
  /** 畳んだ過去のやり取りの要約。まだ 1 度も畳んでいなければ null。 */
  summary: string | null;
  /** まだ畳んでいない生の履歴（古い順）。末尾が今回のユーザー発言。 */
  messages: readonly ChatMessage[];
};

/**
 * 畳んだ要約を、モデルへ渡す本文にする。
 *
 * 前置きは定数で、変わるのは要約そのものだけ。要約は圧縮のたびに書き直されるので、
 * その間は前のターンと頭から一致し、プロンプトキャッシュが当たり続ける。
 */
export function summaryText(summary: string): string {
  return [
    "The conversation history before this point was compacted into the following summary:",
    "",
    "<summary>",
    summary,
    "</summary>",
  ].join("\n");
}

/** assistant の content（本文だけ、または本文とツール呼び出しの並び）。 */
type AssistantContent = Extract<ModelMessage, { role: "assistant" }>["content"];
/** tool の content（ツール呼び出しに対する結果の並び）。 */
type ToolContent = Extract<ModelMessage, { role: "tool" }>["content"];
/** tool の結果 1 件分の output。 */
type ToolResultOutput = Extract<ToolContent[number], { type: "tool-result" }>["output"];

/** 履歴を組み立てるときに、モデル（プロバイダ）の都合を伝える。 */
export type ModelInputOptions = {
  /**
   * プロバイダがツールの結果に画像を置けるかどうか。
   * 置けない場合は、結果の直後に user メッセージとして渡す。
   */
  toolResultImages: boolean;
};

/**
 * 保存済み履歴を、モデルへ渡す形に開く。
 * 生の履歴は要約・言い換え・並べ替えをしない（プロンプトキャッシュを当て続けるため、末尾への追記だけにする）。
 * 古いやり取りは、先頭の user メッセージ 1 件に畳んで置く。
 *
 * 要約を system ではなく user にするのは、ターンの途中で切ったときに履歴が assistant から
 * 始まっても、直前が user の発言になり、プロバイダ側の役割の並びが壊れないため。
 */
export function toModelMessages(
  context: TeraContext,
  images: ImageReader,
  replyLanguage: ReplyLanguage,
  options: ModelInputOptions,
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  // 要約は先頭に 1 件だけ置く。要約が変わらない限り、この前置きは前のターンと一致する。
  if (context.summary !== null) {
    messages.push({ role: "user", content: summaryText(context.summary) });
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: userContentForModel(message) });
      continue;
    }

    const parts = message.parts;
    if (parts === null) {
      throw new Error(`assistant メッセージ ${message.id} に parts がありません`);
    }

    // 添付や注記だけのターンは、モデルへ渡す本文もツールの呼び出しも無い。
    // 空の assistant メッセージを送るとプロバイダに拒まれるので、履歴から省く。
    if (!hasModelContent(parts)) continue;

    messages.push({ role: "assistant", content: toAssistantParts(parts) });

    // ツールの結果に画像を置けないプロバイダのために、結果の直後に続ける画像を集める。
    // 置けるプロバイダでは、結果そのものに画像が入るので、ここには何も残らない。
    const pending: PendingImages[] = [];
    const results = toToolResults(parts, images, options.toolResultImages, pending);
    if (results.length > 0) messages.push({ role: "tool", content: results });

    const imageMessage = pending.length === 0 ? null : imagesMessage(pending, images);
    if (imageMessage !== null) messages.push(imageMessage);
  }

  // 返事の言語は、保存済みの履歴のあと（今回のユーザー発言の後ろ）に置く。
  // 先頭を変えないので、言語が同じ間はプロンプトキャッシュの先頭が当たり続ける。
  messages.push({ role: "user", content: replyLanguageInstruction(replyLanguage) });
  return messages;
}

/**
 * 返事を書く言語の指示。ツールやプロンプトは英語で揃え、言語名だけを切り替える。
 * ユーザーの発言が別の言語でも、設定した言語で書かせる。
 */
const REPLY_LANGUAGE_INSTRUCTIONS: Record<ReplyLanguage, string> = {
  ja: "Reply in Japanese. Write your reply in Japanese, even if the user's message is in another language.",
  en: "Reply in English. Write your reply in English, even if the user's message is in another language.",
};

export function replyLanguageInstruction(language: ReplyLanguage): string {
  return REPLY_LANGUAGE_INSTRUCTIONS[language];
}

/** 結果の直後に user メッセージとして渡す画像。どの呼び出しの画像かを本文で示す。 */
export type PendingImages = {
  /** ツール呼び出しの名前（"computer_screenshot call" など）。 */
  label: string;
  images: readonly ImageRef[];
};

/** 画像を渡すときの本文。どの呼び出しの画像なのかをモデルに示す。 */
function imageText(label: string): string {
  return `(image from the ${label})`;
}

/**
 * ツール結果に載せられない画像を、user メッセージ 1 件にまとめる。
 * 読める画像が 1 枚も無ければ null（読めなかったことはツール結果の本文に残っている）。
 */
export function imagesMessage(entries: readonly PendingImages[], images: ImageReader): ModelMessage | null {
  const texts: string[] = [];
  const files: StoredImages["files"] = [];

  for (const entry of entries) {
    const stored = readStoredImages(entry.images, images);
    for (let index = 0; index < stored.files.length; index += 1) texts.push(imageText(entry.label));
    files.push(...stored.files);
  }

  if (files.length === 0) return null;

  return {
    role: "user",
    content: [{ type: "text", text: texts.join("\n") }, ...files],
  };
}

/**
 * モデルへ実際に渡る入力の仕様。
 *
 * AI SDK の streamText には instructions（= SYSTEM_PROMPT）を渡しているので、
 * プロバイダが受け取るメッセージ列は「system 1 件 + toModelMessages() の結果」になる。
 * ここはそのあるべき形を 1 箇所で表現したもので、キャッシュ保護の回帰テスト
 * （tests/prompt-cache.test.ts）が参照する。
 */
export function buildModelInput(
  context: TeraContext,
  images: ImageReader,
  replyLanguage: ReplyLanguage,
  options: ModelInputOptions,
): ModelMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...toModelMessages(context, images, replyLanguage, options)];
}

/** モデルへ渡せる本文かツールの呼び出しがあるかどうか。 */
function hasModelContent(parts: readonly MessagePart[]): boolean {
  return parts.some((part) => (part.type === "text" && part.text.length > 0) || part.type === "tool-call");
}

/**
 * 本文とツール呼び出しを、保存された順のまま並べる。
 * 添付（attachment）と注記（notice）は、モデルへ戻さない。
 */
function toAssistantParts(parts: readonly MessagePart[]): AssistantContent {
  const hasToolCall = parts.some((part) => part.type === "tool-call");
  const text = parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");

  if (!hasToolCall) {
    if (text.length === 0) {
      throw new Error("assistant メッセージに、モデルへ渡せる本文もツール呼び出しもありません");
    }
    return text;
  }

  const blocks: Exclude<AssistantContent, string> = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "tool-call") {
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
function toToolResults(
  parts: readonly MessagePart[],
  images: ImageReader,
  toolResultImages: boolean,
  pending: PendingImages[],
): ToolContent {
  const results = new Map<string, Extract<MessagePart, { type: "tool-result" }>>();
  for (const part of parts) {
    if (part.type === "tool-result") results.set(part.id, part);
  }

  const blocks: ToolContent = [];
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
            { type: "error-text", value: "This tool call was interrupted before it returned a result." }
          : toToolResultOutput(
              result,
              images,
              toolResultImages,
              `${toolNameFor(part.server, part.tool)} call`,
              pending,
            ),
    });
  }
  return blocks;
}

/**
 * ツールの結果を、モデルへ渡す形にする。
 * 画像を置けるプロバイダでは結果そのものに含め、置けないプロバイダでは
 * 結果の直後の user メッセージ（pending）に回す。
 */
function toToolResultOutput(
  result: Extract<MessagePart, { type: "tool-result" }>,
  images: ImageReader,
  toolResultImages: boolean,
  label: string,
  pending: PendingImages[],
): ToolResultOutput {
  const stored = readStoredImages(result.images ?? [], images);

  if (!toolResultImages && !result.failed && stored.images.length > 0) {
    pending.push({ label, images: stored.images });
  }

  return toolResultOutput({
    text: result.output,
    images: stored,
    failed: result.failed,
    includeImages: toolResultImages,
  });
}

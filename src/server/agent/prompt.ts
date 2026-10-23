import type { ModelMessage } from "ai";
import type { ReplyLanguage } from "../../shared/language";
import type { ChatMessage, ImageRef, MessagePart } from "../../shared/api/message";
import { formatLocalDate } from "../../shared/text";
import { toolNameFor } from "../../shared/tools";
import type { ImageReader } from "../computer/images";
import { userContentForModel } from "./model-content";
import { skillCatalogText } from "./skills";
import type { Skill } from "./skill-types";
import { readStoredImages, toolResultOutput, type StoredImages } from "./tool-output";

/**
 * モデルへ渡す system プロンプト。
 *
 * 固定の文と、identity と、スキルの一覧で組み立てる。日時・ユーザー名・件数・ファイル一覧などを
 * 混ぜると、リクエストの先頭が一致しなくなり、毎回プロンプトキャッシュが外れる。
 * スキルの一覧はターンの開始時に組み立てるので、スキルが変わらない限り前のターンと一致する。
 * スキルが増減したときだけ、そのターンから先頭が変わる。
 * ターンの途中でスキルが増えた場合は system プロンプトを組み直さず、
 * 次のモデル呼び出しの前に user メッセージで知らせる（engine.ts）。
 * identity は圧縮が要約を書き換えたときだけ切り替わる（compaction.ts）。
 * 要約も同じ瞬間に変わるので、その間はプロンプトキャッシュが当たり続ける。
 * 日時のような毎回変わる情報は、履歴の末尾（最後の user メッセージの後ろ）に置く。
 * 畳んだ要約（TeraContext）は、この定数ではなく先頭の user メッセージとして渡す。
 */
const SYSTEM_PROMPT_BASE = [
  "You are Terasuma, a general-purpose assistant running on the user's own machine.",
  "You talk with the user in a chat app.",
  "Your text output is shown to the user as chat messages. Write your reply as normal text; keep it concise and readable.",
  "Use the chat_attach tool only to show an image or file: pass paths inside the computer, or set screenshot to true. It cannot send text.",
  "Images become photos and other files become downloads.",
  "Use the chat_ui tool to show a diagram, a table or a card with choices: it takes one <Card> of UI markup and its description lists the tags. Clicking an option sends that label as the user's next message, so the user can click only after your turn ends.",
  "Always follow the reply-language instruction at the end of the conversation, and write your reply in that language.",
  "The read, write, edit, and bash tools run inside the Debian desktop container that you operate.",
  "Relative paths in read, write, edit, and chat_attach, and the working directory of bash, are /home/agent. Absolute paths are container paths.",
  "Use read to examine a file before changing it. Use edit for targeted changes; use write only for new files or complete rewrites.",
  "MCP server tools and the computer_ tools that drive the container's screen are not in your tool list.",
  "Find them with tool_search (omit the query to list every available tool by name), then run one with tool_call, using the exact name and the arguments its search result describes.",
  "When work in the computer needs an API key or another secret, find computer_set_env with tool_search and call it: the user types the value in the chat and you never see it.",
  "To use GitHub or Discord, find computer_connect_app with tool_search and call it: a card in the chat lets the user paste a token, and the token becomes available to your commands. Never ask the user to send a token as a chat message.",
  'For Discord, the token is a bot token; call app_request with provider "discord" to read and send messages (for example GET or POST /channels/{channel_id}/messages). Do not ask for a user token: automating a user account is not allowed.',
  "Use app_request to call the API of a connected app with its token (for example GET /user on github); the token is never shown to you.",
  "Use history_search to look up earlier conversation with the user, including turns compacted out of your visible history: terms are regular expressions (all must match), from/to take YYYY-MM-DD dates, limit caps the newest matches, and invert/wholeWord work like grep -v/-w.",
  "Skills you created live in the computer at /home/agent/.agents/skills; create, update and delete them with skill_manage. Built-in skills are read-only.",
  "Your identity is your role and the knowledge you need for it. You own it: read or rewrite it with the identity tool.",
  "A rewrite replaces the identity in this prompt only when the conversation is compacted and the summary is rewritten. Until then this prompt keeps the previous version.",
];

/**
 * モデルへ渡す system プロンプト。
 * identity は圧縮のときだけ、スキルの一覧はターンの開始時に変わる。
 */
export function buildSystemPrompt(skills: readonly Skill[], identity: string): string {
  return [
    ...SYSTEM_PROMPT_BASE,
    ...identitySection(identity),
    "Skills (load one with the skill tool before starting work that matches it):",
    skillCatalogText(skills),
  ].join("\n");
}

/** system プロンプトに載せる identity。空なら、これから書けることを伝える。 */
function identitySection(identity: string): string[] {
  if (identity === "") {
    return ["", "Your identity: none yet. Write one with the identity tool when you know the role you take.", ""];
  }
  return ["", "Your identity:", "<identity>", identity, "</identity>", ""];
}

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
  /** 今日の日付を決める時刻（epoch ミリ秒）。テストで固定するために渡す。 */
  now: number,
): ModelMessage[] {
  // 同じターンの中で同じ画像を何度も読まない（履歴には同じ画像が何度も現れる）。
  const reader = memoizeImages(images);
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
    const results = toToolResults(parts, reader, options.toolResultImages, pending);
    if (results.length > 0) messages.push({ role: "tool", content: results });

    const imageMessage = pending.length === 0 ? null : imagesMessage(pending, reader);
    if (imageMessage !== null) messages.push(imageMessage);
  }

  // 返事の言語と今日の日付は、保存済みの履歴のあと（今回のユーザー発言の後ろ）に置く。
  // 先頭を変えないので、プロンプトキャッシュの当たる範囲はそのまま保たれる。
  messages.push({ role: "user", content: turnTail(replyLanguage, now) });
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

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * 履歴の末尾に 1 件だけ置く指示。返事の言語と、今日の日付。
 *
 * 今日の日付は「先週」「先月」を history_search の from/to に直すために要る。
 * 日付は毎日変わるが、その手前（system と保存済みの履歴）は変えないので、
 * プロンプトキャッシュの当たる先頭はそのまま保たれる。
 */
export function turnTail(language: ReplyLanguage, now: number): string {
  const weekday = WEEKDAYS[new Date(now).getDay()] ?? "";

  return `${replyLanguageInstruction(language)}\nToday is ${formatLocalDate(now)} (${weekday}).`;
}

/** 同じターンの中で、同じ画像を 2 度読まない。 */
function memoizeImages(images: ImageReader): ImageReader {
  const cache = new Map<string, Uint8Array | null>();

  return {
    read(ref) {
      const key = `${ref.sha256}:${ref.mime}`;
      if (!cache.has(key)) cache.set(key, images.read(ref));
      return cache.get(key) ?? null;
    },
  };
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
 * AI SDK の streamText には instructions（= buildSystemPrompt()）を渡しているので、
 * プロバイダが受け取るメッセージ列は「system 1 件 + toModelMessages() の結果」になる。
 * ここはそのあるべき形を 1 箇所で表現したもので、キャッシュ保護の回帰テスト
 * （tests/prompt-cache.test.ts）が参照する。
 */
export function buildModelInput(
  context: TeraContext,
  images: ImageReader,
  replyLanguage: ReplyLanguage,
  options: ModelInputOptions,
  now: number,
  skills: readonly Skill[],
  identity: string,
): ModelMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(skills, identity) },
    ...toModelMessages(context, images, replyLanguage, options, now),
  ];
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

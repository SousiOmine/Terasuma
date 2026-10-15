import type { ChatMessage, ImageRef, MessagePart } from "../shared/types";

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
  "You can operate the computer (a separate Debian desktop) through the computer_ tools: its screen, keyboard, mouse, and shell.",
].join("\n");

/** モデルへ渡す assistant の内容の一部。 */
export type AssistantContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

export type ToolResultContentPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  /** 失敗した呼び出しは error-text にして、モデルが自分で直せるようにする。 */
  output: { type: "text" | "error-text"; value: string };
};

/** モデルへ渡す user の内容の一部。ツールが撮った画像もここで渡す。 */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: Uint8Array; mediaType: string };

/**
 * 保存した画像を読み出す口。
 * 履歴を組み立てる側がファイルの場所を知らずに済むよう、ここだけを渡す。
 */
export type ImageReader = {
  read(ref: ImageRef): Uint8Array | null;
};

/**
 * モデルへ渡す会話 1 件分。
 * ツールを使ったターンは assistant（本文とツール呼び出し）と tool（その結果）の 2 件になる。
 */
export type ModelInputMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserContentPart[] }
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
export function toModelMessages(history: readonly ChatMessage[], images: ImageReader): ModelInputMessage[] {
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

    const results = toToolResults(parts, images);
    if (results.length > 0) messages.push({ role: "tool", content: results });

    // 画像は tool の結果に混ぜられない。OpenAI 互換のプロバイダは tool の本文に画像を
    // 置けず、渡しても文字列に潰される（実測）。結果の直後に user メッセージとして置き、
    // どの呼び出しの画像なのかを本文で示す。
    for (const image of toImageMessages(parts, images)) messages.push(image);
  }

  return messages;
}

/** ツールが返した画像を、モデルへ渡す user メッセージにする。 */
function toImageMessages(parts: readonly MessagePart[], images: ImageReader): ModelInputMessage[] {
  return parts.flatMap((part) =>
    part.type === "tool-result" && part.image !== undefined
      ? screenMessage(part.image, images, `${toolNameFor(part.server, part.tool)} call`)
      : [],
  );
}

/**
 * 画像を渡すときの本文。どの呼び出しの画像なのかをモデルに示す。
 * 組み立てる場所が 2 つあるので、文言はここに 1 つだけ置く。
 */
export function screenImageText(label = "computer_screenshot call"): string {
  return `(screen image from the ${label})`;
}

/**
 * 撮った画像を、モデルへ渡す user メッセージにする。
 * 画像は tool の本文に置けないので（OpenAI 互換のプロバイダは文字列へ潰す）、
 * 結果の直後に別のメッセージとして置く。
 */
export function screenMessage(
  image: ImageRef,
  images: ImageReader,
  label = "computer_screenshot call",
): ModelInputMessage[] {
  const data = images.read(image);
  if (data === null) return [];

  return [
    {
      role: "user",
      content: [
        { type: "text", text: screenImageText(label) },
        { type: "image", image: data, mediaType: image.mime },
      ],
    },
  ];
}

/**
 * モデルへ実際に渡る入力の仕様。
 *
 * Mastra の Agent には instructions（= SYSTEM_PROMPT）を渡しているので、プロバイダが受け取る
 * メッセージ列は「system 1 件 + toModelMessages() の結果」になる。ここはそのあるべき形を
 * 1 箇所で表現したもので、キャッシュ保護の回帰テスト（tests/prompt-cache.test.ts）が参照する。
 */
export function buildModelInput(history: readonly ChatMessage[], images: ImageReader): ModelInputMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...toModelMessages(history, images)];
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
function toToolResults(parts: readonly MessagePart[], images: ImageReader): ToolResultContentPart[] {
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
          : toToolResultOutput(result, images),
    });
  }
  return blocks;
}

/**
 * ツールの結果を、モデルへ渡す形にする。
 * 画像はここには入れない（tool の本文に画像を置けるプロバイダが無いため、別の user メッセージで渡す）。
 */
function toToolResultOutput(
  result: Extract<MessagePart, { type: "tool-result" }>,
  images: ImageReader,
): ToolResultContentPart["output"] {
  const asText = (value: string): ToolResultContentPart["output"] => ({
    type: result.failed ? "error-text" : "text",
    value,
  });

  // 参照はあるのに実体が無い状態。黙って本文だけにすると、画像を見たつもりで話が進む。
  if (result.image !== undefined && images.read(result.image) === null) {
    return asText(`${result.output}\n(保存した画像を読み出せませんでした)`);
  }

  return asText(result.output);
}

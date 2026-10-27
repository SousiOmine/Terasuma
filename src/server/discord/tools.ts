import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { DISCORD_CONNECT_TOOL_NAME, DISCORD_SEND_TOOL_NAME } from "../../shared/tools";
import type { DiscordWebhooks } from "./manager";
import type { SentWebhookMessage, WebhookMessage } from "./webhook";
import { reasonInputSchema, requireSignal, type ToolContext } from "../agent/tools/context";

/**
 * Discord の webhook を扱うツール。
 *
 * discord_connect はチャットにコネクタのカードを出し、ユーザーが webhook URL を保存するまで待つ。
 * discord_send は、その Tera のチャンネルへメッセージを投稿する。
 * どちらもツール一覧には載せず、tool_search で見つけて tool_call で実行する。
 * 送信先はターンの Tera で決まるので、ツール一式はターンごとに組む。
 */

/** モデルへ渡すツール。キーは "discord_connect" と "discord_send"。 */
export type DiscordToolset = ToolSet;

/** ツールの供給元。送信先はターンの Tera で決まるので、ターンごとに teraId を渡す。 */
export type DiscordToolsetProvider = {
  toolset(input: { teraId: string }): DiscordToolset;
};

/** 本文の上限（Discord の制限）。 */
const MAX_CONTENT_CHARS = 2_000;

/** 送信者名の上限（Discord の制限）。 */
const MAX_USERNAME_CHARS = 80;

/** 1 回に付けられる埋め込みの上限（Discord の制限）。 */
const MAX_EMBEDS = 10;


/** discord_connect の引数。reason は画面に出すためだけに使う。 */
type ConnectInput = { reason: string };

/** discord_send の引数。 */
type SendInput = {
  content?: string;
  username?: string;
  embeds?: Record<string, unknown>[];
};

export function createDiscordToolset(options: { discord: DiscordWebhooks }): DiscordToolsetProvider {
  return {
    toolset({ teraId }) {
      return {
        [DISCORD_CONNECT_TOOL_NAME]: tool({
          description: [
            "Connect Discord for this Tera by having the user paste the webhook URL of the channel to post to.",
            "Call this when discord_send says Discord is not connected.",
            "A card opens in the chat with a link that explains how to create a webhook and a field to paste the URL.",
            "You never see the URL. Once this returns, discord_send can post to the channel.",
          ].join(" "),
          inputSchema: reasonInputSchema,
          execute: async (_input: ConnectInput, context: ToolContext) => {
            // 中断を受け取れないと、ユーザーを待ったままターンを片付けられなくなる。
            const signal = requireSignal(context);

            return options.discord.wait(teraId, signal);
          },
        }),

        [DISCORD_SEND_TOOL_NAME]: tool({
          description: [
            "Post a message to this Tera's Discord channel through its saved webhook.",
            "content is up to 2000 characters and supports Discord Markdown.",
            "embeds are passed to Discord as-is (at most 10). Pass content, embeds, or both.",
            "Mentions do not notify anyone: the webhook disables them.",
            "A webhook can only post; it cannot read, edit or react.",
            "The channel may have other people in it, so ask the user before posting long or private text.",
          ].join(" "),
          inputSchema: z.object({
            content: z.string().max(MAX_CONTENT_CHARS).optional().describe("Message text (up to 2000 characters)"),
            username: z
              .string()
              .max(MAX_USERNAME_CHARS)
              .optional()
              .describe("Display name for this message, overriding the webhook's name"),
            embeds: z
              .array(z.record(z.string(), z.unknown()))
              .min(1)
              .max(MAX_EMBEDS)
              .optional()
              .describe("Embed objects, passed to Discord as-is (title, description, color, fields, ...)"),
          }),
          execute: async (input: SendInput, context: ToolContext) => {
            const sent = await options.discord.send(teraId, messageOf(input), context.abortSignal);
            return sentText(sent);
          },
        }),
      };
    },
  };
}

/** 引数を送る形に整える。空のメッセージは Discord が受け付けないので、ここで断る。 */
function messageOf(input: SendInput): WebhookMessage {
  const content = (input.content ?? "").trim();
  const embeds = input.embeds ?? null;

  if (content.length === 0 && embeds === null) {
    throw new Error("A message needs content or embeds.");
  }

  const username = (input.username ?? "").trim();

  return {
    content: content.length === 0 ? null : content,
    username: username.length === 0 ? null : username,
    embeds,
  };
}

/** 投稿できたことを、どのチャンネルへ送ったかと一緒に返す。 */
function sentText(sent: SentWebhookMessage): string {
  const target = sent.channelId === null ? "the channel" : `channel ${sent.channelId}`;

  return sent.messageId === null ? `Posted a message to ${target}.` : `Posted message ${sent.messageId} to ${target}.`;
}

import { describeError } from "../../shared/errors";
import { readErrorDetail, sendRequestOrThrow, type FetchLike } from "../http/client";

/**
 * Discord の webhook の URL と、その API。
 *
 * webhook URL は、そのチャンネルへ投稿できる権利そのもの（秘密）。
 * 保存する前に GET で疎通を確かめ、送信は POST で行う。
 * URL は Discord の webhook だけを受け付ける。別のサービスの URL を貼ったときに、
 * どこへ送るのか分からないまま動くのを防ぐため。
 */

/** 1 回の HTTP の上限。応答しないサーバーで設定操作を止めない。 */
const HTTP_TIMEOUT_MS = 15_000;

/** 送信の上限。Discord が混んでいるときも、ターンを長く止めない。 */
const SEND_TIMEOUT_MS = 30_000;

/** webhook URL を受け付けるホスト。 */
const WEBHOOK_HOSTS: readonly string[] = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"];

/** webhook URL のパス。/api/webhooks/<id>/<token> と /api/v10/webhooks/<id>/<token> を受ける。 */
const WEBHOOK_PATH = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([A-Za-z0-9._-]+)\/?$/;

/** エラーの本文を読む上限（文字数）。 */
const MAX_ERROR_CHARS = 300;

/**
 * 貼られた URL を、送信に使う形へ正規化する。
 *
 * 版（/api/v10/...）・末尾のスラッシュ・問い合わせ文字列は落とし、送信先を 1 つに決める。
 * 受け付けられない URL は例外にする（呼び出し側が画面の入力エラーへ読み替える）。
 */
export function parseWebhookUrl(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) throw new Error("The webhook URL is empty");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("The webhook URL is not a valid URL");
  }

  if (url.protocol !== "https:") throw new Error("The webhook URL must start with https://");
  if (!WEBHOOK_HOSTS.includes(url.hostname)) {
    throw new Error("The webhook URL must be a Discord webhook (https://discord.com/api/webhooks/...)");
  }

  const match = WEBHOOK_PATH.exec(url.pathname);
  const id = match?.[1];
  const token = match?.[2];
  if (id === undefined || token === undefined) {
    throw new Error("The webhook URL must look like https://discord.com/api/webhooks/<id>/<token>");
  }

  return `https://discord.com/api/webhooks/${id}/${token}`;
}

/** webhook を読んで分かること。 */
export type WebhookInfo = {
  /** Discord 側で付けた webhook の名前。分からなければ null。 */
  name: string | null;
  /** 送信先のチャンネル ID。分からなければ null。 */
  channelId: string | null;
};

/**
 * 保存する前に webhook を確かめる。
 * 受け付けられない URL（消えた webhook・書き間違い）は、そのまま保存しない。
 */
export async function verifyWebhook(url: string, fetchImpl: FetchLike): Promise<WebhookInfo> {
  const response = await sendRequestOrThrow(
    fetchImpl,
    url,
    { headers: { Accept: "application/json" } },
    {
      timeoutMs: HTTP_TIMEOUT_MS,
      onNetwork: (error) => new Error(`Could not reach Discord: ${describeError(error)}`, { cause: error }),
    },
  );
  if (!response.ok) throw new Error(webhookErrorMessage(response.status));

  const data = await readJsonObject(response);
  return { name: stringFieldOf(data, "name"), channelId: stringFieldOf(data, "channel_id") };
}

/** 送るメッセージ。本文と埋め込みの少なくとも一方は要る（呼び出し側が確かめる）。 */
export type WebhookMessage = {
  /** 本文。省略するときは null。 */
  content: string | null;
  /** 送信者名の上書き。省略するときは null。 */
  username: string | null;
  /** 埋め込み。Discord がそのまま解釈するので、形はここでは確かめない。 */
  embeds: readonly Record<string, unknown>[] | null;
};

/** 投稿できたメッセージ。 */
export type SentWebhookMessage = {
  /** 投稿されたメッセージの ID。返らなかったときは null。 */
  messageId: string | null;
  /** 投稿先のチャンネル ID。返らなかったときは null。 */
  channelId: string | null;
};

/**
 * チャンネルへメッセージを投稿する。
 *
 * wait=true を付けると、投稿されたメッセージが応答で返る（成功を ID で確かめられる）。
 * メンションは通知しない（本文に @everyone が混ざっても誤爆させない）。
 */
export async function sendWebhookMessage(
  url: string,
  message: WebhookMessage,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<SentWebhookMessage> {
  const body: Record<string, unknown> = { allowed_mentions: { parse: [] } };
  if (message.content !== null) body["content"] = message.content;
  if (message.username !== null) body["username"] = message.username;
  if (message.embeds !== null) body["embeds"] = message.embeds;

  const response = await sendRequestOrThrow(
    fetchImpl,
    `${url}?wait=true`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    {
      timeoutMs: SEND_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
      onNetwork: (error) => new Error(`Could not reach Discord: ${describeError(error)}`, { cause: error }),
    },
  );
  if (response.ok) {
    const data = await readJsonObject(response);
    return { messageId: stringFieldOf(data, "id"), channelId: stringFieldOf(data, "channel_id") };
  }

  throw new Error(await sendErrorMessage(response));
}

/** 保存するときの失敗の文。状態コードから、次に何をすればよいかを決める。 */
function webhookErrorMessage(status: number): string {
  if (status === 404) {
    return "Discord did not find the webhook (HTTP 404). Check the URL, or create a new webhook.";
  }
  if (status === 401 || status === 403) {
    return `Discord rejected the webhook URL (HTTP ${status}). Create a new webhook and paste its URL again.`;
  }
  return `Discord did not accept the webhook URL (HTTP ${status}).`;
}

/** 送信の失敗の文。429 は再試行までの秒数を伝える（呼び出し側が繰り返さないように）。 */
async function sendErrorMessage(response: Response): Promise<string> {
  if (response.status === 429) {
    const data = await readJsonObjectOrNull(response);
    const retry = data?.["retry_after"];
    const seconds = typeof retry === "number" && Number.isFinite(retry) ? Math.ceil(retry) : null;
    return seconds === null
      ? "Discord is rate limiting this webhook. Wait a minute before sending again."
      : `Discord is rate limiting this webhook. Send again in ${seconds} second(s).`;
  }
  if (response.status === 404) {
    return "Discord did not find the webhook (HTTP 404). The webhook may have been deleted; ask the user to save a new URL.";
  }
  if (response.status === 401 || response.status === 403) {
    return `Discord rejected the webhook URL (HTTP ${response.status}). Ask the user to save a new URL.`;
  }
  if (response.status === 400) {
    const detail = await readErrorDetail(response, MAX_ERROR_CHARS);
    return detail.length === 0 ? "Discord rejected the message (HTTP 400)." : `Discord rejected the message: ${detail}`;
  }
  return `Discord did not accept the message (HTTP ${response.status}).`;
}

/** JSON のオブジェクトとして読む。読めなければ例外にする。 */
async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const data = await readJsonObjectOrNull(response);
  if (data === null) throw new Error("Discord returned an unexpected response");
  return data;
}

/** JSON のオブジェクトとして読む。読めなければ null（本文を読み捨てたいときに使う）。 */
async function readJsonObjectOrNull(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 文字列の項目を読む。空文字と他の型は null にする。 */
function stringFieldOf(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

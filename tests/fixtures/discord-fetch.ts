import type { FetchLike } from "../../src/server/http/client";

/**
 * Discord の webhook API を真似る fetch。
 *
 * 本物の送信先は https://discord.com にしか無く、テストでは URL の検証を通せない
 * （http://127.0.0.1 の偽サーバーは Discord のホストではないため）。
 * そこで fetch だけを差し替え、URL の検証と送信本文の組み立ては本物を通す。
 */

/** テストで使う webhook URL。 */
export const WEBHOOK_URL = "https://discord.com/api/webhooks/123456789/token-abc";

/** 偽サーバーが返す webhook の名前。 */
export const WEBHOOK_NAME = "Terasuma";

/** 偽サーバーが返すチャンネル ID。 */
export const WEBHOOK_CHANNEL_ID = "987654321";

/** 届いた要求 1 件。 */
export type WebhookRequest = {
  url: string;
  method: string;
  /** JSON の本文。本文が無ければ null。 */
  body: Record<string, unknown> | null;
};

export type FakeDiscord = {
  fetch: FetchLike;
  /** 届いた要求（古い順）。 */
  requests: WebhookRequest[];
  /** 次の応答を差し替える。null で既定の応答に戻す。 */
  respond(response: Response | null): void;
};

export function createFakeDiscordFetch(): FakeDiscord {
  const requests: WebhookRequest[] = [];
  let override: Response | null = null;

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ url: input, method, body });

    // 差し替えた応答は何度でも読めるように、呼ばれるたびに複製を返す。
    if (override !== null) return override.clone();

    if (method === "GET" && url.pathname.startsWith("/api/webhooks/")) {
      return Response.json({ id: "123456789", name: WEBHOOK_NAME, channel_id: WEBHOOK_CHANNEL_ID, guild_id: "555" });
    }

    if (method === "POST" && url.pathname.startsWith("/api/webhooks/")) {
      return Response.json({
        id: "msg-1",
        channel_id: WEBHOOK_CHANNEL_ID,
        content: body?.["content"] ?? "",
      });
    }

    return new Response("not found", { status: 404 });
  };

  return {
    fetch: fetchImpl,
    requests,
    respond(response) {
      override = response;
    },
  };
}

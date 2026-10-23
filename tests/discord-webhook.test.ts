import { describe, expect, test } from "bun:test";
import { parseWebhookUrl, sendWebhookMessage, verifyWebhook } from "../src/server/discord/webhook";
import {
  createFakeDiscordFetch,
  WEBHOOK_CHANNEL_ID,
  WEBHOOK_NAME,
  WEBHOOK_URL,
} from "./fixtures/discord-fetch";

/**
 * Discord の webhook URL の検証と、API の読み替え。
 * 通信は fetch の差し替えで行い、URL の形と本文の組み立てを本物の実装で確かめる。
 */

describe("webhook URL", () => {
  test("Discord の webhook URL を受け付け、送信に使う形へ揃える", () => {
    expect(parseWebhookUrl(WEBHOOK_URL)).toBe(WEBHOOK_URL);
    // 版と問い合わせ文字列、前後の空白と末尾のスラッシュは落とす。
    expect(parseWebhookUrl(`  https://discord.com/api/v10/webhooks/123456789/token-abc/?wait=true  `)).toBe(
      WEBHOOK_URL,
    );
    // discordapp.com も受けるが、送信先は discord.com に揃える。
    expect(parseWebhookUrl("https://discordapp.com/api/webhooks/1/tok")).toBe(
      "https://discord.com/api/webhooks/1/tok",
    );
  });

  test("Discord の webhook ではない URL は断る", () => {
    for (const url of [
      "",
      "not a url",
      "http://discord.com/api/webhooks/1/tok",
      "https://example.test/api/webhooks/1/tok",
      "https://evil-discord.com/api/webhooks/1/tok",
      "https://discord.com/channels/1",
      "https://discord.com/api/webhooks/1",
      "https://discord.com/api/webhooks/abc/tok",
    ]) {
      expect(() => parseWebhookUrl(url)).toThrow();
    }
  });
});

describe("webhook の確認", () => {
  test("webhook を読むと、名前とチャンネル ID が分かる", async () => {
    const fake = createFakeDiscordFetch();

    expect(await verifyWebhook(WEBHOOK_URL, fake.fetch)).toEqual({
      name: WEBHOOK_NAME,
      channelId: WEBHOOK_CHANNEL_ID,
    });
  });

  test("見つからない webhook は、理由を付けて断る", async () => {
    const fake = createFakeDiscordFetch();
    fake.respond(new Response("not found", { status: 404 }));

    expect(verifyWebhook(WEBHOOK_URL, fake.fetch)).rejects.toThrow(/did not find the webhook/);
  });
});

describe("webhook への送信", () => {
  test("本文・送信者名・埋め込みを送り、メンションは通知しない", async () => {
    const fake = createFakeDiscordFetch();

    const sent = await sendWebhookMessage(
      WEBHOOK_URL,
      { content: "hello", username: "Tera", embeds: [{ title: "t" }] },
      fake.fetch,
    );

    expect(sent).toEqual({ messageId: "msg-1", channelId: WEBHOOK_CHANNEL_ID });
    expect(fake.requests[0]?.url).toBe(`${WEBHOOK_URL}?wait=true`);
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.body).toEqual({
      allowed_mentions: { parse: [] },
      content: "hello",
      username: "Tera",
      embeds: [{ title: "t" }],
    });
  });

  test("本文と送信者名が無ければ、その項目を送らない", async () => {
    const fake = createFakeDiscordFetch();

    await sendWebhookMessage(WEBHOOK_URL, { content: null, username: null, embeds: [{ title: "t" }] }, fake.fetch);

    expect(fake.requests[0]?.body).toEqual({ allowed_mentions: { parse: [] }, embeds: [{ title: "t" }] });
  });

  test("429 は、再試行までの秒数を伝える", async () => {
    const fake = createFakeDiscordFetch();
    fake.respond(Response.json({ retry_after: 4.2, global: false }, { status: 429 }));

    expect(
      sendWebhookMessage(WEBHOOK_URL, { content: "x", username: null, embeds: null }, fake.fetch),
    ).rejects.toThrow(/5 second/);
  });

  test("400 は、Discord が返した理由を伝える", async () => {
    const fake = createFakeDiscordFetch();
    fake.respond(Response.json({ message: "Invalid Form Body" }, { status: 400 }));

    expect(
      sendWebhookMessage(WEBHOOK_URL, { content: "x", username: null, embeds: null }, fake.fetch),
    ).rejects.toThrow(/Invalid Form Body/);
  });

  test("401 は、URL を保存し直すよう促す", async () => {
    const fake = createFakeDiscordFetch();
    fake.respond(new Response("unauthorized", { status: 401 }));

    expect(
      sendWebhookMessage(WEBHOOK_URL, { content: "x", username: null, embeds: null }, fake.fetch),
    ).rejects.toThrow(/save a new URL/);
  });
});

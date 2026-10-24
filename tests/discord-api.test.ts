import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDiscordWebhooks } from "../src/server/discord/manager";
import type { DiscordWebhooksView } from "../src/shared/api/discord";
import { type ServerHarness, withServer } from "./harness";
import {
  createFakeDiscordFetch,
  WEBHOOK_CHANNEL_ID,
  WEBHOOK_NAME,
  WEBHOOK_URL,
  type FakeDiscord,
} from "./fixtures/discord-fetch";

/**
 * Discord の webhook の HTTP API。
 * webhook の確認と送信は fetch の差し替えで行う（本物の宛先は discord.com に限られるため）。
 */

type Run = (harness: ServerHarness, fake: FakeDiscord) => Promise<void>;

async function withDiscordServer(run: Run): Promise<void> {
  const fake = createFakeDiscordFetch();
  await withServer((harness) => run(harness, fake), {
    discord: ({ store, dir }) => createDiscordWebhooks({ store, dataDir: dir, fetch: fake.fetch }),
  });
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** 一覧を読む。 */
async function discord(harness: ServerHarness): Promise<DiscordWebhooksView> {
  const response = await harness.request("/api/discord");
  expect(response.status).toBe(200);
  return (await response.json()) as DiscordWebhooksView;
}

describe("Discord の webhook の API", () => {
  test("一覧は Tera ごとの未接続の状態を返す", async () => {
    await withDiscordServer(async (harness) => {
      const view = await discord(harness);

      expect(view.teras).toHaveLength(1);
      expect(view.teras[0]).toMatchObject({
        teraId: "default",
        teraName: "Tera",
        connected: false,
        webhookName: null,
        channelId: null,
        detail: null,
      });
      expect(view.setupUrl).toContain("discord.com");
    });
  });

  test("webhook を保存すると、接続済みとして返す", async () => {
    await withDiscordServer(async (harness, fake) => {
      const response = await harness.request("/api/discord/default", jsonRequest("PUT", { url: `  ${WEBHOOK_URL}  ` }));

      expect(response.status).toBe(200);
      expect(((await response.json()) as DiscordWebhooksView).teras[0]).toMatchObject({
        connected: true,
        webhookName: WEBHOOK_NAME,
        channelId: WEBHOOK_CHANNEL_ID,
      });

      // 保存する前に、webhook を読んで確かめている。
      expect(fake.requests[0]?.method).toBe("GET");
      expect(fake.requests[0]?.url).toBe(WEBHOOK_URL);

      // URL は本人だけが読める権限で保存する。
      expect(existsSync(join(harness.dir, "discord", "default.json"))).toBe(true);
    });
  });

  test("受け付けられない URL は 400", async () => {
    await withDiscordServer(async (harness) => {
      const response = await harness.request(
        "/api/discord/default",
        jsonRequest("PUT", { url: "https://example.test/api/webhooks/1/tok" }),
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
      expect((await discord(harness)).teras[0]?.connected).toBe(false);
    });
  });

  test("Discord が知らない webhook は 400", async () => {
    await withDiscordServer(async (harness, fake) => {
      fake.respond(new Response("not found", { status: 404 }));

      const response = await harness.request("/api/discord/default", jsonRequest("PUT", { url: WEBHOOK_URL }));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { detail: string }).detail).toContain("did not find the webhook");
    });
  });

  test("空の URL は 400", async () => {
    await withDiscordServer(async (harness) => {
      const response = await harness.request("/api/discord/default", jsonRequest("PUT", { url: "  " }));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("保存した webhook を切断すると消える", async () => {
    await withDiscordServer(async (harness) => {
      await harness.request("/api/discord/default", jsonRequest("PUT", { url: WEBHOOK_URL }));

      const removed = await harness.request("/api/discord/default", { method: "DELETE" });

      expect(removed.status).toBe(200);
      expect(((await removed.json()) as DiscordWebhooksView).teras[0]?.connected).toBe(false);
      expect(existsSync(join(harness.dir, "discord", "default.json"))).toBe(false);
    });
  });

  test("接続の待ちを中止できる", async () => {
    await withDiscordServer(async (harness) => {
      const response = await harness.request("/api/discord/default/wait", { method: "DELETE" });

      expect(response.status).toBe(200);
      expect(((await response.json()) as DiscordWebhooksView).teras[0]?.connected).toBe(false);
    });
  });

  test("知らない Tera は 404", async () => {
    await withDiscordServer(async (harness) => {
      const response = await harness.request("/api/discord/unknown", jsonRequest("PUT", { url: WEBHOOK_URL }));

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("tera_not_found");
    });
  });
});

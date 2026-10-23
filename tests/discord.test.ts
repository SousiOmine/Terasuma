import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStore, DEFAULT_TERA_ID, type Store } from "../src/server/data/store";
import { createDiscordWebhooks, type DiscordWebhooks } from "../src/server/discord/manager";
import { withTempDir } from "./harness";
import {
  createFakeDiscordFetch,
  WEBHOOK_CHANNEL_ID,
  WEBHOOK_NAME,
  WEBHOOK_URL,
  type FakeDiscord,
} from "./fixtures/discord-fetch";

/**
 * Discord の webhook（Tera ごとの保存・確認・待ち・送信）。
 * 通信は fetch の差し替えで行い、保存の権限と、待ちを解く順番を確かめる。
 */

type Context = {
  discord: DiscordWebhooks;
  store: Store;
  dir: string;
  fake: FakeDiscord;
};

async function withDiscord(run: (context: Context) => Promise<void>): Promise<void> {
  await withTempDir("terasuma-discord-", async (dir) => {
    const store = createStore(":memory:");
    store.ensureTera(DEFAULT_TERA_ID, "Tera");

    const fake = createFakeDiscordFetch();
    const discord = createDiscordWebhooks({ store, dataDir: dir, fetch: fake.fetch });

    try {
      await run({ discord, store, dir, fake });
    } finally {
      discord.close();
      store.close();
    }
  });
}

/** 保存するファイルのパス。 */
function webhookPath(dir: string): string {
  return join(dir, "discord", `${DEFAULT_TERA_ID}.json`);
}

/**
 * 失敗するまで待って、理由を 1 文で返す。
 * Bun 1.4.3 の expect(...).rejects は未解決の promise を待ってくれるが、
 * その場で待ちに入ってしまうため、トリガーより前に呼ぶテストでは使えない。
 */
function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "(resolved)",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("Discord の webhook", () => {
  test("保存すると接続済みになり、webhook の名前とチャンネルが分かる", async () => {
    await withDiscord(async ({ discord, dir }) => {
      const view = await discord.set(DEFAULT_TERA_ID, `  ${WEBHOOK_URL}  `);

      expect(view.teras[0]).toMatchObject({
        teraId: DEFAULT_TERA_ID,
        teraName: "Tera",
        connected: true,
        webhookName: WEBHOOK_NAME,
        channelId: WEBHOOK_CHANNEL_ID,
        detail: null,
      });

      // URL は秘密なので、本人だけが読める権限で保存する。
      const path = webhookPath(dir);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        url: WEBHOOK_URL,
        name: WEBHOOK_NAME,
        channelId: WEBHOOK_CHANNEL_ID,
      });
    });
  });

  test("受け付けられない URL は保存しない", async () => {
    await withDiscord(async ({ discord, dir }) => {
      expect(await rejectionOf(discord.set(DEFAULT_TERA_ID, "https://example.test/api/webhooks/1/tok"))).toMatch(
        /Discord webhook/,
      );

      expect(existsSync(webhookPath(dir))).toBe(false);
      expect(discord.view().teras[0]?.connected).toBe(false);
    });
  });

  test("Discord が知らない webhook は保存しない", async () => {
    await withDiscord(async ({ discord, dir, fake }) => {
      fake.respond(new Response("not found", { status: 404 }));

      expect(await rejectionOf(discord.set(DEFAULT_TERA_ID, WEBHOOK_URL))).toMatch(/did not find the webhook/);
      expect(existsSync(webhookPath(dir))).toBe(false);
    });
  });

  test("webhook が保存されるまで待つ", async () => {
    await withDiscord(async ({ discord }) => {
      const waiting = discord.wait(DEFAULT_TERA_ID, new AbortController().signal);

      await discord.set(DEFAULT_TERA_ID, WEBHOOK_URL);

      const text = await waiting;
      expect(text).toContain(WEBHOOK_CHANNEL_ID);
      expect(text).toContain("discord_send");
    });
  });

  test("接続済みなら、待たずに使い方を返す", async () => {
    await withDiscord(async ({ discord }) => {
      await discord.set(DEFAULT_TERA_ID, WEBHOOK_URL);

      expect(await discord.wait(DEFAULT_TERA_ID, new AbortController().signal)).toContain("is connected");
    });
  });

  test("ターンが止まると、待ちは外れる", async () => {
    await withDiscord(async ({ discord }) => {
      const controller = new AbortController();
      const rejected = rejectionOf(discord.wait(DEFAULT_TERA_ID, controller.signal));

      controller.abort();
      expect(await rejected).toMatch(/turn ended/);
    });
  });

  test("取り消すと、待ちは理由付きで失敗する", async () => {
    await withDiscord(async ({ discord }) => {
      const rejected = rejectionOf(discord.wait(DEFAULT_TERA_ID, new AbortController().signal));

      discord.cancelWait(DEFAULT_TERA_ID);
      expect(await rejected).toMatch(/cancelled/);
    });
  });

  test("切断すると、保存した URL も消える", async () => {
    await withDiscord(async ({ discord, dir }) => {
      await discord.set(DEFAULT_TERA_ID, WEBHOOK_URL);
      expect(existsSync(webhookPath(dir))).toBe(true);

      const view = discord.clear(DEFAULT_TERA_ID);

      expect(existsSync(webhookPath(dir))).toBe(false);
      expect(view.teras[0]).toMatchObject({ connected: false, webhookName: null, channelId: null });
    });
  });

  test("保存されている値が壊れていたら、理由を出す", async () => {
    await withDiscord(async ({ discord, dir }) => {
      mkdirSync(join(dir, "discord"), { recursive: true });
      writeFileSync(webhookPath(dir), "{ not json", "utf8");

      expect(discord.view().teras[0]?.detail).not.toBeNull();
      expect(await rejectionOf(discord.wait(DEFAULT_TERA_ID, new AbortController().signal))).toMatch(
        /could not be read/,
      );
    });
  });

  test("webhook ではない値は、接続済みにしない", async () => {
    await withDiscord(async ({ discord, dir }) => {
      // 以前の bot トークンのような、URL ではない値を読んでも送信先にしない。
      mkdirSync(join(dir, "discord"), { recursive: true });
      writeFileSync(webhookPath(dir), JSON.stringify({ url: "bot-token-1", savedAt: 0 }), "utf8");

      expect(discord.view().teras[0]?.connected).toBe(false);
      expect(discord.view().teras[0]?.detail).toContain("webhook");
    });
  });

  test("送ると、本文と名前と埋め込みが webhook へ渡る", async () => {
    await withDiscord(async ({ discord, fake }) => {
      await discord.set(DEFAULT_TERA_ID, WEBHOOK_URL);

      const sent = await discord.send(DEFAULT_TERA_ID, {
        content: "hello",
        username: "Tera",
        embeds: [{ title: "t" }],
      });

      expect(sent).toEqual({ messageId: "msg-1", channelId: WEBHOOK_CHANNEL_ID });
      expect(fake.requests.at(-1)?.url).toBe(`${WEBHOOK_URL}?wait=true`);
      expect(fake.requests.at(-1)?.body).toEqual({
        allowed_mentions: { parse: [] },
        content: "hello",
        username: "Tera",
        embeds: [{ title: "t" }],
      });
    });
  });

  test("未接続なら送らずに、接続の仕方を返す", async () => {
    await withDiscord(async ({ discord, fake }) => {
      expect(
        await rejectionOf(discord.send(DEFAULT_TERA_ID, { content: "x", username: null, embeds: null })),
      ).toMatch(/discord_connect/);
      expect(fake.requests).toEqual([]);
    });
  });

  test("知らない Tera id は、通信する前に断る", async () => {
    await withDiscord(async ({ discord, fake }) => {
      expect(await rejectionOf(discord.set("../escape", WEBHOOK_URL))).toMatch(/is not known/);
      expect(fake.requests).toEqual([]);
    });
  });

  test("終了すると、待ちは止まる", async () => {
    await withDiscord(async ({ discord }) => {
      const rejected = rejectionOf(discord.wait(DEFAULT_TERA_ID, new AbortController().signal));

      discord.close();
      expect(await rejected).toMatch(/shutting down/);
    });
  });
});

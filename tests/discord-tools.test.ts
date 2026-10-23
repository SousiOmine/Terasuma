import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { createToolRegistry } from "../src/server/agent/tools/registry";
import { createStore, DEFAULT_TERA_ID } from "../src/server/data/store";
import { createDiscordWebhooks, type DiscordWebhooks } from "../src/server/discord/manager";
import { createDiscordToolset } from "../src/server/discord/tools";
import { withTempDir } from "./harness";
import { createFakeDiscordFetch, WEBHOOK_URL, type FakeDiscord } from "./fixtures/discord-fetch";

/**
 * Discord のツール（discord_connect / discord_send）。
 * モデルを介さずにツールをそのまま呼び、戻り値と失敗の文を確かめる。
 */

type Context = {
  tools: ToolSet;
  discord: DiscordWebhooks;
  dir: string;
  fake: FakeDiscord;
};

async function withTools(run: (context: Context) => Promise<void>): Promise<void> {
  await withTempDir("terasuma-discord-tools-", async (dir) => {
    const store = createStore(":memory:");
    store.ensureTera(DEFAULT_TERA_ID, "Tera");

    const fake = createFakeDiscordFetch();
    const discord = createDiscordWebhooks({ store, dataDir: dir, fetch: fake.fetch });
    const tools = createDiscordToolset({ discord }).toolset({ teraId: DEFAULT_TERA_ID });

    try {
      await run({ tools, discord, dir, fake });
    } finally {
      discord.close();
      store.close();
    }
  });
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function callTool(
  tools: ToolSet,
  name: string,
  input: unknown,
  context: { abortSignal?: AbortSignal } = {},
): Promise<unknown> {
  const entry = tools[name];
  if (entry?.execute === undefined) throw new Error(`${name} が無い`);
  return entry.execute(input as never, context as never);
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

describe("Discord のツール", () => {
  test("ツール名は discord_connect と discord_send", async () => {
    await withTools(async ({ tools }) => {
      expect(Object.keys(tools)).toEqual(["discord_connect", "discord_send"]);
    });
  });

  test("tool_search で見つかり、引数の上限はレジストリが確かめる", async () => {
    await withTools(async ({ tools }) => {
      const registry = await createToolRegistry(tools);

      expect(registry.search("discord", 10).map((match) => match.name)).toEqual([
        "discord_connect",
        "discord_send",
      ]);

      // 2000 文字を超える本文は、送る前に断る。
      await expect(
        registry.call("discord_send", { content: "x".repeat(2001) }, { toolCallId: "c1" }),
      ).rejects.toThrow(/Invalid arguments/);
    });
  });

  test("未接続なら、送信は接続を促す", async () => {
    await withTools(async ({ tools }) => {
      expect(await rejectionOf(callTool(tools, "discord_send", { content: "hello" }))).toMatch(/discord_connect/);
    });
  });

  test("discord_connect は保存されるまで待ち、以後は待たない", async () => {
    await withTools(async ({ tools, discord }) => {
      const context = { abortSignal: new AbortController().signal };
      const waiting = callTool(tools, "discord_connect", { reason: "通知を送るため" }, context);

      await discord.set(DEFAULT_TERA_ID, WEBHOOK_URL);
      expect(await waiting).toContain("Discord is connected");

      expect(
        await callTool(tools, "discord_connect", { reason: "もう一度" }, context),
      ).toContain("is connected");
    });
  });

  test("接続済みなら、本文と埋め込みを送れる", async () => {
    await withTools(async ({ tools, discord, fake }) => {
      await discord.set(DEFAULT_TERA_ID, WEBHOOK_URL);

      const result = await callTool(tools, "discord_send", {
        content: "hello",
        embeds: [{ title: "t" }],
      });

      expect(result).toContain("msg-1");
      expect(fake.requests.at(-1)?.body).toMatchObject({
        content: "hello",
        embeds: [{ title: "t" }],
        allowed_mentions: { parse: [] },
      });
    });
  });

  test("送信者名は、指定したときだけ渡る", async () => {
    await withTools(async ({ tools, discord, fake }) => {
      await discord.set(DEFAULT_TERA_ID, WEBHOOK_URL);

      await callTool(tools, "discord_send", { content: "hello", username: "  Tera  " });

      expect(fake.requests.at(-1)?.body).toEqual({
        allowed_mentions: { parse: [] },
        content: "hello",
        username: "Tera",
      });
    });
  });

  test("本文も埋め込みも無いメッセージは断る", async () => {
    await withTools(async ({ tools, discord }) => {
      await discord.set(DEFAULT_TERA_ID, WEBHOOK_URL);

      expect(await rejectionOf(callTool(tools, "discord_send", {}))).toMatch(/content or embeds/);
      expect(await rejectionOf(callTool(tools, "discord_send", { content: "   " }))).toMatch(/content or embeds/);
    });
  });

  test("ターンが止まると、接続の待ちも終わる", async () => {
    await withTools(async ({ tools }) => {
      const controller = new AbortController();
      const waiting = callTool(
        tools,
        "discord_connect",
        { reason: "通知を送るため" },
        { abortSignal: controller.signal },
      );
      const rejected = rejectionOf(waiting);

      controller.abort();
      expect(await rejected).toMatch(/turn ended/);
    });
  });
});

import { describe, expect, test } from "bun:test";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ModelSettings } from "../src/config";
import { createMastraEngine, type EngineEvent, type SettingsReader, type ToolsetProvider } from "../src/server/engine";
import type { ChatMessage } from "../src/shared/types";

/**
 * 1 回目の呼び出しではツールを呼び、2 回目では本文を返す偽のプロバイダ。
 * モデルへツールが渡り、呼び出しが実行されて結果が戻るまでを 1 つの流れで確かめる。
 */
function startFakeProvider() {
  const bodies: Record<string, unknown>[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
      const first = bodies.length === 1;

      const encoder = new TextEncoder();
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 0,
            model: "test-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );

      const frames: Uint8Array[] = first
        ? [
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "local_echo", arguments: '{"text":"hi"}' },
                  },
                ],
              },
              null,
            ),
            chunk({}, "tool_calls"),
          ]
        : [chunk({ role: "assistant", content: "呼び出しました" }, null), chunk({}, "stop")];

      frames.push(encoder.encode("data: [DONE]\n\n"));

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(frame);
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });

  return { server, bodies };
}

/** 記録できるツールを 1 つ持つ供給元。 */
function createToolsetProvider(): ToolsetProvider & { executed: unknown[] } {
  const executed: unknown[] = [];
  const echo = createTool({
    id: "local_echo",
    description: "テスト用の echo",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }: { text: string }) => {
      executed.push(text);
      return `echo: ${text}`;
    },
  });

  return { executed, toolset: async () => ({ local_echo: echo }) };
}

function settingsFor(port: number): ModelSettings {
  return {
    model: "custom-1/test-model",
    providers: { "custom-1": { baseUrl: `http://127.0.0.1:${port}/v1` } },
    modelOptions: {},
  };
}

function history(): ChatMessage[] {
  return [
    {
      id: "m1",
      sessionId: "s1",
      seq: 1,
      role: "user",
      content: "調べて",
      parts: null,
      createdAt: 0,
      usage: null,
    },
  ];
}

function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("偽のプロバイダのポートが取れていない");
  return server.port;
}

/** ツールの定義を、プロバイダへ渡る形（OpenAI 互換）から取り出す。 */
function toolNames(body: Record<string, unknown> | undefined): string[] {
  const tools = body?.["tools"];
  if (!Array.isArray(tools)) return [];

  return tools.flatMap((tool) => {
    const fn = (tool as { function?: { name?: unknown } }).function;
    return typeof fn?.name === "string" ? [fn.name] : [];
  });
}

async function run(provider: ToolsetProvider, settings: ModelSettings): Promise<EngineEvent[]> {
  const reader: SettingsReader = { read: () => settings };
  const stream = await createMastraEngine(reader, provider).stream({
    history: history(),
    signal: new AbortController().signal,
  });

  const events: EngineEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

describe("MCP のツール呼び出し（Mastra 経由）", () => {
  test("ツールがモデルへ渡り、呼び出しと結果が流れて本文で終わる", async () => {
    const fake = startFakeProvider();
    const provider = createToolsetProvider();

    try {
      const events = await run(provider, settingsFor(portOf(fake.server)));

      expect(toolNames(fake.bodies[0])).toEqual(["local_echo"]);
      expect(provider.executed).toEqual(["hi"]);

      expect(events).toEqual([
        {
          type: "tool-call",
          part: { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
        },
        {
          type: "tool-result",
          part: {
            type: "tool-result",
            id: "call-1",
            server: "local",
            tool: "echo",
            failed: false,
            output: "echo: hi",
          },
        },
        { type: "text-delta", delta: "呼び出しました" },
      ]);

      // 2 回目の呼び出しには、ツールの結果が載っている。
      expect(fake.bodies).toHaveLength(2);
      expect(JSON.stringify(fake.bodies[1])).toContain("echo: hi");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("ツールが無ければ、プロバイダへツールを送らない", async () => {
    const fake = startFakeProvider();

    try {
      await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)));
      expect(fake.bodies[0]?.["tools"]).toBeUndefined();
    } finally {
      await fake.server.stop(true);
    }
  });

  // Mastra（AI SDK）は 5xx を既定で 2 回まで再試行するので、その分だけ待つ。
  test("プロバイダが失敗したら、空の応答にせず失敗させる", async () => {
    // ストリームの途中でエラーがチャンクとして流れてくる場合も、黙って空文字にしない。
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ error: { message: "壊れています" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    });

    try {
      const failure = await run({ toolset: async () => ({}) }, settingsFor(portOf(server))).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
    } finally {
      await server.stop(true);
    }
  }, 20_000);
});

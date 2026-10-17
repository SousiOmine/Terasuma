import { describe, expect, test } from "bun:test";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ModelSettings } from "../src/config";
import { createComputerTools } from "../src/server/computer";
import type { ContainerManager } from "../src/server/container";
import {
  createMastraEngine,
  type ComputerToolsetProvider,
  type EngineEvent,
  type SettingsReader,
  type ToolsetProvider,
} from "../src/server/engine";
import type { ChatMessage } from "../src/shared/types";
import { createHandover } from "../src/server/handover";
import { createComputerStub, createContainerStub, createImageStub } from "./support";

/**
 * 1 回目の呼び出しではツールを呼び、2 回目では本文を返す偽のプロバイダ。
 * モデルへツールが渡り、呼び出しが実行されて結果が戻るまでを 1 つの流れで確かめる。
 */
function startFakeProvider(call: { name: string; args: string } = { name: "local_echo", args: '{"text":"hi"}' }) {
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
                    function: { name: call.name, arguments: call.args },
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

/** shell だけを差し替えたコンテナ。実行されたコマンドを記録する。 */
function createShellContainer(stdout: string): { container: ContainerManager; commands: string[] } {
  const commands: string[] = [];

  return {
    commands,
    container: {
      ...createContainerStub(),
      shell: async (script) => {
        commands.push(script);
        return { exitCode: 0, stdout, stderr: "", truncated: false, timedOut: false };
      },
    },
  };
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
      teraId: "t1",
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

async function run(
  provider: ToolsetProvider,
  settings: ModelSettings,
  computer: ComputerToolsetProvider = createComputerStub(),
): Promise<EngineEvent[]> {
  const reader: SettingsReader = { read: () => settings };
  const stream = await createMastraEngine(reader, provider, computer, createImageStub()).stream({
    context: { observations: null, messages: history() },
    signal: new AbortController().signal,
    teraId: "t1",
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

  test("コンテナのツールもモデルへ渡り、computer_shell が実行される", async () => {
    const fake = startFakeProvider({ name: "computer_shell", args: '{"command":"uname -a"}' });
    const { container, commands } = createShellContainer("Linux test 7.0.0\n");

    try {
      const events = await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)), {
        toolset: async () => createComputerTools({ container, images: createImageStub(), handover: createHandover(), teraId: "t1" }),
      });

      // MCP と同じ名前空間（"<ツールセット名>_<ツール名>"）でモデルへ渡る。
      expect(toolNames(fake.bodies[0])).toContain("computer_shell");
      expect(commands).toEqual(["uname -a"]);

      expect(events).toEqual([
        {
          type: "tool-call",
          part: { type: "tool-call", id: "call-1", server: "computer", tool: "shell", args: { command: "uname -a" } },
        },
        {
          type: "tool-result",
          part: {
            type: "tool-result",
            id: "call-1",
            server: "computer",
            tool: "shell",
            failed: false,
            output: "exit code: 0\n--- stdout ---\nLinux test 7.0.0",
          },
        },
        { type: "text-delta", delta: "呼び出しました" },
      ]);

      // 2 回目の呼び出しには、シェルの結果が載っている。
      expect(JSON.stringify(fake.bodies[1])).toContain("Linux test 7.0.0");
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

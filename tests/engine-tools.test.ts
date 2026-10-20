import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import type { ModelSettings } from "../src/config";
import { createCodingToolset, type CodingToolset } from "../src/server/coding";
import { createComputerTools } from "../src/server/computer";
import type { ContainerManager } from "../src/server/container";
import {
  createAiSdkEngine,
  type ComputerToolsetProvider,
  type EngineEvent,
  type SettingsReader,
  type ToolsetProvider,
} from "../src/server/engine";
import type { ChatMessage } from "../src/shared/types";
import { createHandover } from "../src/server/handover";
import { createCodingStub, createComputerStub, createContainerStub, createImageStub } from "./support";

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

/**
 * 1 ターンの中で、指定した回数だけツールを呼ばせる偽のプロバイダ。
 * 最後の 1 回は本文を返す。1 ターンの上限が小さいままだと途中で打ち切られ、
 * 呼ばれた回数が減るので、上限の回帰をここで見る。
 */
function startToolLoopProvider(toolCalls: number) {
  const bodies: Record<string, unknown>[] = [];
  const encoder = new TextEncoder();
  const frame = (delta: Record<string, unknown>, finish: string | null) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
      const callNumber = bodies.length;

      const frames: Uint8Array[] =
        callNumber <= toolCalls
          ? [
              frame(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${callNumber}`,
                      type: "function",
                      function: { name: "local_echo", arguments: '{"text":"hi"}' },
                    },
                  ],
                },
                null,
              ),
              frame({}, "tool_calls"),
            ]
          : [frame({ role: "assistant", content: "終わりました" }, null), frame({}, "stop")];

      frames.push(encoder.encode("data: [DONE]\n\n"));

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of frames) controller.enqueue(part);
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
  const echo = tool({
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
  coding: CodingToolset = createCodingStub(),
): Promise<EngineEvent[]> {
  const reader: SettingsReader = { read: () => settings };
  const stream = await createAiSdkEngine({
    settings: reader,
    mcp: provider,
    computer,
    coding,
    images: createImageStub(),
    catalog: { snapshot: () => null },
  }).stream({
    context: { summary: null, messages: history() },
    signal: new AbortController().signal,
    teraId: "t1",
    replyLanguage: "ja",
  });

  const events: EngineEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

describe("MCP のツール呼び出し（AI SDK 経由）", () => {
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

  test("コンテナのツールもモデルへ渡り、computer_open が実行される", async () => {
    const fake = startFakeProvider({ name: "computer_open", args: '{"command":"xterm"}' });
    const { container, commands } = createShellContainer("");

    try {
      const events = await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)), {
        toolset: async () => createComputerTools({ container, images: createImageStub(), handover: createHandover(), teraId: "t1" }),
      });

      // MCP と同じ名前空間（"<ツールセット名>_<ツール名>"）でモデルへ渡る。
      expect(toolNames(fake.bodies[0])).toContain("computer_open");
      expect(commands).toEqual(["nohup 'xterm' >/dev/null 2>&1 &"]);

      expect(events).toEqual([
        {
          type: "tool-call",
          part: { type: "tool-call", id: "call-1", server: "computer", tool: "open", args: { command: "xterm" } },
        },
        {
          type: "tool-result",
          part: {
            type: "tool-result",
            id: "call-1",
            server: "computer",
            tool: "open",
            failed: false,
            output: "started xterm",
          },
        },
        { type: "text-delta", delta: "呼び出しました" },
      ]);

      // 2 回目の呼び出しには、起動したアプリ名が載っている。
      expect(JSON.stringify(fake.bodies[1])).toContain("started xterm");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("コンテナの read ツールもモデルへ渡り、ファイルを読める", async () => {
    const container: ContainerManager = {
      ...createContainerStub(),
      readFile: async (path) => {
        expect(path).toBe("/home/agent/note.txt");
        return new TextEncoder().encode("hello from the container\n");
      },
    };

    const fake = startFakeProvider({ name: "read", args: JSON.stringify({ path: "note.txt" }) });

    try {
      const events = await run(
        { toolset: async () => ({}) },
        settingsFor(portOf(fake.server)),
        createComputerStub(),
        createCodingToolset({ container, root: "/home/agent" }),
      );

      // コンテナのツールは接頭辞を付けず、そのままの名前でモデルへ渡る。
      expect(toolNames(fake.bodies[0])).toContain("read");

      expect(events[0]).toEqual({
        type: "tool-call",
        part: { type: "tool-call", id: "call-1", server: "", tool: "read", args: { path: "note.txt" } },
      });

      const result = events[1];
      if (result?.type !== "tool-result") throw new Error("read の結果が返らなかった");
      expect(result.part.failed).toBe(false);
      expect(result.part.output).toContain("hello from the container");

      // 2 回目の呼び出しには、読んだ内容が載っている。
      expect(JSON.stringify(fake.bodies[1])).toContain("hello from the container");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("失敗したツールの結果は、JSON の包装ではなくエラー本文で渡る", async () => {
    const fake = startFakeProvider({ name: "local_fail", args: "{}" });
    const provider: ToolsetProvider = {
      toolset: async () => ({
        local_fail: tool({
          description: "テスト用の失敗",
          inputSchema: z.object({}),
          execute: async (): Promise<string> => {
            throw new Error("boom");
          },
        }),
      }),
    };

    try {
      const events = await run(provider, settingsFor(portOf(fake.server)));
      const result = events[1];
      if (result?.type !== "tool-result") throw new Error("ツールの結果が返らなかった");

      expect(result.part.failed).toBe(true);
      expect(result.part.output).toBe("boom");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("1 ターンで 5 回を超えてツールを呼べる", async () => {
    const toolCalls = 6;
    const fake = startToolLoopProvider(toolCalls);
    const provider = createToolsetProvider();

    try {
      const events = await run(provider, settingsFor(portOf(fake.server)));
      const reportedCalls = events.filter((event) => event.type === "tool-call").length;
      const text = events
        .filter((event): event is Extract<EngineEvent, { type: "text-delta" }> => event.type === "text-delta")
        .map((event) => event.delta)
        .join("");

      expect(provider.executed).toHaveLength(toolCalls);
      expect(reportedCalls).toBe(toolCalls);
      expect(fake.bodies).toHaveLength(toolCalls + 1);
      expect(text).toContain("終わりました");
      expect(text).not.toContain("上限");
    } finally {
      await fake.server.stop(true);
    }
  });

  // AI SDK は 5xx を既定で 2 回まで再試行するので、その分だけ待つ。
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

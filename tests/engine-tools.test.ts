import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ModelSettings } from "../src/server/data/settings";
import { createCodingToolset } from "../src/server/agent/tools/coding";
import { createComputerTools } from "../src/server/agent/tools/computer";
import { createTeraToolset } from "../src/server/agent/tools/tera";
import type { ContainerManager } from "../src/server/computer/container";
import { createAiSdkEngine } from "../src/server/agent/engine/sdk";
import type { EngineEvent, SettingsReader } from "../src/server/agent/engine";
import type {
  AttachmentToolsetProvider,
  CodingToolsetProvider,
  ComputerToolsetProvider,
  HistoryToolsetProvider,
  ToolsetProvider,
} from "../src/server/agent/contracts";
import { createAttachmentTools } from "../src/server/agent/tools/attachments";
import { createHistoryToolset } from "../src/server/agent/tools/history";
import { createFileStore } from "../src/server/computer/files";
import type { ChatMessage, ImageRef, SentAttachment } from "../src/shared/api/message";
import { createImageStore, type ImageStore } from "../src/server/computer/images";
import type { CatalogSnapshot } from "../src/server/provider/catalog";
import type { SkillFileStore } from "../src/server/agent/skill-types";
import type { IdentityStore } from "../src/server/agent/identity";

import { createHandover } from "../src/server/computer/handover";
import {
  createCodingStub,
  createComputerStub,
  createConnectionToolsStub,
  createDiscordToolsStub,
  createTeraToolsStub,
  createContainerStub,
  createEnvRequestsStub,
  createHistoryStub,
  createImageStub,
  createAttachmentsStub,
  createIdentityStoreStub,
  createSkillFileStoreStub,
  createWebSearchToolsStub,
  makeStore,
  testPng,
} from "./support";

/**
 * 偽のプロバイダが 1 回の呼び出しで返すもの。
 * ツール検索の流れは何ステップにもなるので、ツール呼び出しと本文を手順として並べる。
 */
type ProviderStep = { tool: string; args: string } | { text: string };

/**
 * 手順どおりに応答する偽のプロバイダ。1 回の呼び出しで 1 つのツール呼び出し、または本文を返す。
 * 手順が尽きたら空の本文で終わる（呼びすぎはテストの手順の側で気づけるようにする）。
 */
function startScriptedProvider(steps: readonly ProviderStep[]) {
  const bodies: Record<string, unknown>[] = [];
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

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
      const call = bodies.length;
      const step = steps[call - 1];

      const frames: Uint8Array[] = [];
      if (step !== undefined && "tool" in step) {
        frames.push(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${call}`,
                  type: "function",
                  function: { name: step.tool, arguments: step.args },
                },
              ],
            },
            null,
          ),
          chunk({}, "tool_calls"),
        );
      } else {
        frames.push(chunk({ role: "assistant", content: step !== undefined && "text" in step ? step.text : "" }, null));
        frames.push(chunk({}, "stop"));
      }
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

type ToolCallEvent = Extract<EngineEvent, { type: "tool-call" }>;
type ToolResultEvent = Extract<EngineEvent, { type: "tool-result" }>;

/** 指定したツールの呼び出し。エンジンは名前を "<サーバー id>_<ツール名>" に分けて流す。 */
function callsOf(events: readonly EngineEvent[], server: string, tool: string): ToolCallEvent[] {
  return events.filter(
    (event): event is ToolCallEvent =>
      event.type === "tool-call" && event.part.server === server && event.part.tool === tool,
  );
}

/** tool_call が実行しようとしているツール名。 */
function calledName(event: ToolCallEvent): string | null {
  const args = event.part.args;
  if (typeof args !== "object" || args === null) return null;

  const name = (args as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

/** 呼び出し 1 つ分の結果。返っていなければ止める。 */
function resultOf(events: readonly EngineEvent[], id: string): ToolResultEvent {
  const result = events.find((event): event is ToolResultEvent => event.type === "tool-result" && event.part.id === id);
  if (result === undefined) throw new Error(`ツールの結果が返らなかった（呼び出し ${id}）`);
  return result;
}

/** 条件が満たされるまで少しずつ待つ。待ち時間を決め打ちにしないため。 */
async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("待っていた状態になりませんでした");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

/** 画像を 1 枚返すツールを 1 つ持つ供給元。 */
function createImageToolsetProvider(ref: ImageRef): ToolsetProvider {
  return {
    toolset: async () => ({
      local_shot: tool({
        description: "テスト用の画像",
        inputSchema: z.object({}),
        execute: async () => ({ text: "撮りました", images: [ref] }),
      }),
    }),
  };
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
      attachments: null,
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
  coding: CodingToolsetProvider = createCodingStub(),
  images: ImageStore = createImageStub(),
  catalog: CatalogSnapshot | null = null,
  attachments: AttachmentToolsetProvider = createAttachmentsStub(),
  attached: SentAttachment[] = [],
  historyTools: HistoryToolsetProvider = createHistoryStub(),
  skills: SkillFileStore = createSkillFileStoreStub(),
  identity: IdentityStore = createIdentityStoreStub(),
): Promise<EngineEvent[]> {
  const reader: SettingsReader = { read: () => settings };
  const stream = await createAiSdkEngine({
    settings: reader,
    mcp: provider,
    computer,
    attachments,
    history: historyTools,
    webSearch: createWebSearchToolsStub(),
    connections: createConnectionToolsStub(),
    discord: createDiscordToolsStub(),
    tera: createTeraToolsStub(),
    coding,
    images,
    catalog: { snapshot: () => catalog },
    skills,
    identity,
  }).stream({
    context: { summary: null, messages: history() },
    signal: new AbortController().signal,
    teraId: "t1",
    replyLanguage: "ja",
    attach: (files) => attached.push(...files),
    takeSteering: () => [],
  });

  const events: EngineEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

describe("ツール検索（AI SDK 経由）", () => {
  test("MCP のツールは最初から渡らず、tool_search で見つけて tool_call で実行できる", async () => {
    const fake = startScriptedProvider([
      { tool: "tool_search", args: JSON.stringify({ query: "local" }) },
      { tool: "tool_call", args: JSON.stringify({ name: "local_echo", args: { text: "hi" } }) },
      { text: "呼び出しました" },
    ]);
    const provider = createToolsetProvider();

    try {
      const events = await run(provider, settingsFor(portOf(fake.server)));

      // 事前に渡るのは内蔵のツールだけ。MCP のツール定義はリクエストに載らない。
      expect(toolNames(fake.bodies[0]).sort()).toEqual([
        "chat_ui",
        "identity",
        "skill",
        "skill_manage",
        "tool_call",
        "tool_search",
      ]);

      // 検索の結果には、名前・説明・引数スキーマが載る。
      const searched = JSON.stringify(fake.bodies[1]);
      expect(searched).toContain("local_echo");
      expect(searched).toContain("Arguments (JSON Schema)");
      expect(searched).toContain("properties");

      // 見つけたツールは tool_call から実行でき、結果は名前付きでモデルへ渡る。
      expect(provider.executed).toEqual(["hi"]);
      expect(JSON.stringify(fake.bodies[2])).toContain("[local_echo]");
      expect(JSON.stringify(fake.bodies[2])).toContain("echo: hi");

      expect(callsOf(events, "tool", "search")).toHaveLength(1);

      const call = callsOf(events, "tool", "call")[0];
      if (call === undefined) throw new Error("tool_call がモデルへ渡らなかった");
      expect(calledName(call)).toBe("local_echo");

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(false);
      expect(result.part.output).toBe("[local_echo]\necho: hi");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("スキル → ツール検索 → tool_call の流れが 1 ターンで通る", async () => {
    const fake = startScriptedProvider([
      { tool: "skill", args: JSON.stringify({ name: "computer-use" }) },
      { tool: "tool_search", args: JSON.stringify({ query: "computer" }) },
      { tool: "tool_call", args: JSON.stringify({ name: "computer_open", args: { command: "xterm" } }) },
      { text: "起動しました" },
    ]);
    const { container, commands } = createShellContainer("");

    try {
      const events = await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)), {
        toolset: async () =>
          createComputerTools({
            container,
            images: createImageStub(),
            handover: createHandover(),
            env: createEnvRequestsStub(),
            teraId: "t1",
          }),
      });

      // スキルの本文 → 検索結果 → 実行、の順にモデルへ渡る。
      expect(JSON.stringify(fake.bodies[1])).toContain("tool_search");
      expect(JSON.stringify(fake.bodies[2])).toContain("computer_open");
      expect(commands).toEqual(["nohup 'xterm' >/dev/null 2>&1 &"]);

      expect(callsOf(events, "", "skill")).toHaveLength(1);
      expect(callsOf(events, "tool", "search")).toHaveLength(1);
      expect(callsOf(events, "tool", "call")).toHaveLength(1);
    } finally {
      await fake.server.stop(true);
    }
  });

  test("tera_create は tool_search で見つかり、tool_call を経て Tera を作る", async () => {
    const fake = startScriptedProvider([
      { tool: "tool_search", args: JSON.stringify({ query: "tera create" }) },
      {
        tool: "tool_call",
        args: JSON.stringify({
          name: "tera_create",
          args: { id: "researcher", name: "調べる係", role: "技術記事を調べる。", policy: "出典を示す。" },
        }),
      },
      { text: "作りました" },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "terasuma-engine-tera-"));
    const store = makeStore();

    try {
      const stream = await createAiSdkEngine({
        settings: { read: () => settingsFor(portOf(fake.server)) },
        mcp: { toolset: async () => ({}) },
        computer: createComputerStub(),
        attachments: createAttachmentsStub(),
        history: createHistoryStub(),
        webSearch: createWebSearchToolsStub(),
        connections: createConnectionToolsStub(),
        discord: createDiscordToolsStub(),
        tera: createTeraToolset({ store, dataDir: dir }),
        coding: createCodingStub(),
        images: createImageStub(),
        catalog: { snapshot: () => null },
        skills: createSkillFileStoreStub(),
        identity: createIdentityStoreStub(),
      }).stream({
        context: { summary: null, messages: history() },
        signal: new AbortController().signal,
        teraId: "t1",
        replyLanguage: "ja",
        attach: () => undefined,
        takeSteering: () => [],
      });

      const events: EngineEvent[] = [];
      for await (const event of stream.events) events.push(event);

      // 検索の結果には、名前と引数スキーマが載る。
      const searched = JSON.stringify(fake.bodies[1]);
      expect(searched).toContain("tera_create");
      expect(searched).toContain("Arguments (JSON Schema)");

      // tool_call 越しに実行され、Tera とその identity ができる。
      expect(callsOf(events, "tool", "call")).toHaveLength(1);
      expect(store.getTera("researcher")?.name).toBe("調べる係");
      expect(store.readIdentity("researcher").applied).toContain("技術記事を調べる。");
    } finally {
      await fake.server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("つなぐツールが無くても、内蔵のツール（tool_search / tool_call / skill / skill_manage / identity）は渡す", async () => {
    const fake = startScriptedProvider([{ text: "はい" }]);

    try {
      await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)));
      expect(toolNames(fake.bodies[0]).sort()).toEqual([
        "chat_ui",
        "identity",
        "skill",
        "skill_manage",
        "tool_call",
        "tool_search",
      ]);
    } finally {
      await fake.server.stop(true);
    }
  });

  test("知らない名前は、理由つきの失敗としてモデルへ返る", async () => {
    const fake = startScriptedProvider([
      { tool: "tool_call", args: JSON.stringify({ name: "nope_nope", args: {} }) },
      { text: "分かりました" },
    ]);

    try {
      const events = await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)));
      const call = callsOf(events, "tool", "call")[0];
      if (call === undefined) throw new Error("tool_call が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(true);
      expect(result.part.output).toContain('Unknown tool "nope_nope"');
      expect(result.part.output).toContain("tool_search");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("引数がスキーマに合わないときは、理由つきの失敗としてモデルへ返る", async () => {
    const fake = startScriptedProvider([
      { tool: "tool_call", args: JSON.stringify({ name: "local_echo", args: {} }) },
      { text: "分かりました" },
    ]);
    const provider = createToolsetProvider();

    try {
      const events = await run(provider, settingsFor(portOf(fake.server)));
      const call = callsOf(events, "tool", "call")[0];
      if (call === undefined) throw new Error("tool_call が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(true);
      expect(result.part.output).toContain('Invalid arguments for "local_echo"');
      expect(provider.executed).toEqual([]);
    } finally {
      await fake.server.stop(true);
    }
  });

  test("computer-use スキルを読め、本文にツール検索の手順が載っている", async () => {
    const fake = startScriptedProvider([
      { tool: "skill", args: JSON.stringify({ name: "computer-use" }) },
      { text: "読みました" },
    ]);

    try {
      const events = await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)));

      const call = callsOf(events, "", "skill")[0];
      if (call === undefined) throw new Error("skill が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(false);
      expect(result.part.output).toContain("tool_search");
      expect(result.part.output).toContain("computer_screenshot");

      // 本文は次の呼び出しでモデルへ渡る。
      expect(JSON.stringify(fake.bodies[1])).toContain("computer_screenshot");
    } finally {
      await fake.server.stop(true);
    }
  });
  test("skill_manage で作ったスキルを同じターンで読め、追加は user メッセージで知らせる", async () => {
    const fake = startScriptedProvider([
      {
        tool: "skill_manage",
        args: JSON.stringify({
          action: "create",
          name: "deploy-notes",
          description: "Deploy notes",
          content: "# Deploy\n\nRun make deploy.",
        }),
      },
      { tool: "skill", args: JSON.stringify({ name: "deploy-notes" }) },
      { text: "保存して読みました" },
    ]);
    const skills = createSkillFileStoreStub();

    try {
      const events = await run(
        { toolset: async () => ({}) },
        settingsFor(portOf(fake.server)),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        skills,
      );

      const manage = callsOf(events, "skill", "manage")[0];
      if (manage === undefined) throw new Error("skill_manage が呼ばれなかった");
      expect(resultOf(events, manage.part.id).part.failed).toBe(false);

      // 作成したことが、次の呼び出しの user メッセージとして届く。
      expect(JSON.stringify(fake.bodies[1])).toContain("A skill was created during this turn");
      expect(JSON.stringify(fake.bodies[1])).toContain("deploy-notes");

      const load = callsOf(events, "", "skill")[0];
      if (load === undefined) throw new Error("skill が呼ばれなかった");
      const loaded = resultOf(events, load.part.id);
      expect(loaded.part.failed).toBe(false);
      expect(loaded.part.output).toContain("Run make deploy.");
      expect(loaded.part.output).toContain("Skill directory: /home/agent/.agents/skills/deploy-notes");
    } finally {
      await fake.server.stop(true);
    }
  });
});

describe("履歴検索（AI SDK 経由）", () => {
  test("history_search は事前に渡り、保存された過去のやり取りを引ける", async () => {
    const store = makeStore();
    // ターンの対象と同じ Tera に履歴を置く（run は teraId "t1" でターンを流す）。
    store.ensureTera("t1", "テスト");
    store.appendMessage({ id: "m1", teraId: "t1", role: "user", content: "先週の件はどうなった" });
    store.appendMessage({
      id: "m2",
      teraId: "t1",
      role: "assistant",
      content: "",
      parts: [
        { type: "text", text: "金曜までに直します。", at: 1 },
        { type: "tool-call", id: "call-1", server: "", tool: "read", args: { path: "/secret/path" } },
        { type: "tool-result", id: "call-1", server: "", tool: "read", failed: false, output: "秘密の出力" },
      ],
    });

    const fake = startScriptedProvider([
      { tool: "history_search", args: JSON.stringify({ query: "金曜" }) },
      { text: "見つけました" },
    ]);

    try {
      const events = await run(
        { toolset: async () => ({}) },
        settingsFor(portOf(fake.server)),
        createComputerStub(),
        createCodingStub(),
        createImageStub(),
        null,
        createAttachmentsStub(),
        [],
        createHistoryToolset({ store }),
      );

      // 履歴検索は tool_search を挟まず、そのままの名前でモデルへ渡る。
      expect(toolNames(fake.bodies[0])).toContain("history_search");

      const call = callsOf(events, "history", "search")[0];
      if (call === undefined) throw new Error("history_search が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(false);
      expect(result.part.output).toContain("金曜までに直します。");

      // ツール呼び出しは名前だけ。引数と結果は検索の結果に載らない。
      expect(result.part.output).toContain("(tool calls: read)");
      expect(result.part.output).not.toContain("/secret/path");
      expect(result.part.output).not.toContain("秘密の出力");

      // 引いた本文は、次の呼び出しでモデルへ渡る。
      expect(JSON.stringify(fake.bodies[1])).toContain("金曜までに直します。");
    } finally {
      await fake.server.stop(true);
    }
  });
});

describe("コンテナのツール（tool_call 経由）", () => {
  test("computer_open が tool_call から実行される", async () => {
    const fake = startScriptedProvider([
      { tool: "tool_call", args: JSON.stringify({ name: "computer_open", args: { command: "xterm" } }) },
      { text: "起動しました" },
    ]);
    const { container, commands } = createShellContainer("");

    try {
      const events = await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)), {
        toolset: async () =>
          createComputerTools({
            container,
            images: createImageStub(),
            handover: createHandover(),
            env: createEnvRequestsStub(),
            teraId: "t1",
          }),
      });

      // コンテナのツールは事前に渡らず、tool_call からだけ実行できる。
      expect(toolNames(fake.bodies[0])).not.toContain("computer_open");
      expect(commands).toEqual(["nohup 'xterm' >/dev/null 2>&1 &"]);

      const call = callsOf(events, "tool", "call")[0];
      if (call === undefined) throw new Error("tool_call が呼ばれなかった");
      expect(calledName(call)).toBe("computer_open");
      expect(resultOf(events, call.part.id).part.output).toBe("[computer_open]\nstarted xterm");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("computer_ask_user は tool_call 越しでもユーザーの返事を待ち、戻り値になる", async () => {
    const fake = startScriptedProvider([
      {
        tool: "tool_call",
        args: JSON.stringify({ name: "computer_ask_user", args: { question: "ログインしてください" } }),
      },
      { text: "ありがとうございます" },
    ]);
    const handover = createHandover();

    try {
      const running = run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)), {
        toolset: async () =>
          createComputerTools({
            container: createContainerStub(),
            images: createImageStub(),
            handover,
            env: createEnvRequestsStub(),
            teraId: "t1",
          }),
      });

      // 引き受けが始まるまで待ち、ユーザーの返事を届ける。
      await waitUntil(() => handover.answer("t1", { kind: "text", text: "できました" }));
      const events = await running;

      const call = callsOf(events, "tool", "call")[0];
      if (call === undefined) throw new Error("tool_call が呼ばれなかった");
      expect(resultOf(events, call.part.id).part.output).toBe("[computer_ask_user]\nできました");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("読み書きのツールは事前に渡り、read でファイルを読める", async () => {
    const container: ContainerManager = {
      ...createContainerStub(),
      readFile: async (path) => {
        expect(path).toBe("/home/agent/teras/t1/note.txt");
        return new TextEncoder().encode("hello from the container\n");
      },
    };

    const fake = startScriptedProvider([
      { tool: "read", args: JSON.stringify({ path: "note.txt" }) },
      { text: "読みました" },
    ]);

    try {
      const events = await run(
        { toolset: async () => ({}) },
        settingsFor(portOf(fake.server)),
        createComputerStub(),
        // 相対パスは、このターンの Tera（t1）の作業フォルダから解決する。
        { toolset: () => createCodingToolset({ container, root: "/home/agent/teras/t1" }) },
      );

      // コンテナの読み書きは、ツール検索を挟まずにそのままの名前でモデルへ渡る。
      expect(toolNames(fake.bodies[0])).toContain("read");

      const call = callsOf(events, "", "read")[0];
      if (call === undefined) throw new Error("read が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(false);
      expect(result.part.output).toContain("hello from the container");

      // 2 回目の呼び出しには、読んだ内容が載っている。
      expect(JSON.stringify(fake.bodies[1])).toContain("hello from the container");
    } finally {
      await fake.server.stop(true);
    }
  });
});

describe("作業場", () => {
  test("system プロンプトに、自分の作業場と、ほかの Tera の作業場の案内が載る", async () => {
    const fake = startScriptedProvider([{ text: "わかりました" }]);

    try {
      await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)));

      // 相対パスの基準は、このターンの Tera（t1）の作業フォルダ。
      const prompt = JSON.stringify(fake.bodies[0]);
      expect(prompt).toContain("Your workspace is /home/agent/teras/t1.");
      expect(prompt).toContain("Other Teras' workspaces are sibling folders under /home/agent/teras");
    } finally {
      await fake.server.stop(true);
    }
  });
});

describe("添付", () => {
  test("chat_attach ツールがモデルへ渡り、添付がターンの外へ出る", async () => {
    const fake = startScriptedProvider([{ tool: "chat_attach", args: '{"screenshot":true}' }, { text: "送りました" }]);
    const dir = mkdtempSync(join(tmpdir(), "terasuma-engine-"));
    const images = createImageStore(dir);
    const files = createFileStore(dir);
    const attached: SentAttachment[] = [];
    const attachments: AttachmentToolsetProvider = {
      toolset: ({ attach }) =>
        createAttachmentTools({
          container: {
            readFile: async () => {
              throw new Error("テストではファイルを読まない");
            },
            screenshot: async () => testPng(1280, 800),
          },
          root: "/home/agent",
          images,
          files,
          attach,
        }),
    };

    try {
      await run(
        { toolset: async () => ({}) },
        settingsFor(portOf(fake.server)),
        createComputerStub(),
        createCodingStub(),
        images,
        null,
        attachments,
        attached,
      );

      // モデルへ渡す名前は "chat_attach"（サーバー id とツール名の規則に乗る）。
      expect(toolNames(fake.bodies[0])).toContain("chat_attach");
      expect(attached).toHaveLength(1);
      expect(attached[0]?.name).toBe("screenshot.png");
      expect(attached[0]?.image).toEqual({ width: 1280, height: 800 });
    } finally {
      await fake.server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ツールの結果", () => {
  test("失敗したツールの結果は、JSON の包装ではなくエラー本文で渡る", async () => {
    const fake = startScriptedProvider([
      { tool: "tool_call", args: JSON.stringify({ name: "local_fail", args: {} }) },
      { text: "失敗しました" },
    ]);
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
      const call = callsOf(events, "tool", "call")[0];
      if (call === undefined) throw new Error("tool_call が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(true);
      expect(result.part.output).toBe("boom");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("ツールが返した画像は、tool_call 越しでもツールの結果としてモデルへ渡る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-engine-"));
    const images = createImageStore(dir);
    const png = testPng(4, 3);
    const ref = images.save(png, "image/png");

    const fake = startScriptedProvider([
      { tool: "tool_call", args: JSON.stringify({ name: "local_shot" }) },
      { text: "撮りました" },
    ]);

    try {
      const events = await run(
        createImageToolsetProvider(ref),
        settingsFor(portOf(fake.server)),
        createComputerStub(),
        createCodingStub(),
        images,
      );

      const call = callsOf(events, "tool", "call")[0];
      if (call === undefined) throw new Error("tool_call が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.output).toBe("[local_shot]\n撮りました");
      expect(result.part.images).toEqual([ref]);

      // 2 回目の呼び出しでは、ツールの結果そのものに画像が入っている。
      const messages = (fake.bodies[1]?.["messages"] ?? []) as { role: string; content: unknown }[];
      const toolMessage = messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toEqual([
        { type: "text", text: "[local_shot]\n撮りました" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` },
        },
      ]);
    } finally {
      await fake.server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("画像を結果に置けないプロバイダには、次のステップで user メッセージとして渡す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-engine-"));
    const images = createImageStore(dir);
    const png = testPng(4, 3);
    const ref = images.save(png, "image/png");

    const fake = startScriptedProvider([
      { tool: "tool_call", args: JSON.stringify({ name: "local_shot" }) },
      { text: "撮りました" },
    ]);
    const catalog: CatalogSnapshot = {
      fetchedAt: 0,
      providers: [
        {
          id: "cerebras",
          name: "Cerebras",
          npm: "@ai-sdk/cerebras",
          api: `http://127.0.0.1:${portOf(fake.server)}/v1`,
        },
      ],
      models: new Map(),
    };

    try {
      const events = await run(
        createImageToolsetProvider(ref),
        {
          model: "cerebras/test-model",
          providers: { cerebras: { apiKey: "test-key" } },
          modelOptions: {},
        },
        createComputerStub(),
        createCodingStub(),
        images,
        catalog,
      );

      const call = callsOf(events, "tool", "call")[0];
      if (call === undefined) throw new Error("tool_call が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.images).toEqual([ref]);

      // ツールの結果には画像を置かず、結果の直後の user メッセージで渡す。
      const messages = (fake.bodies[1]?.["messages"] ?? []) as { role: string; content: unknown }[];
      const toolMessage = messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toBe("[local_shot]\n撮りました");

      const imageMessage = messages.filter((message) => message.role === "user").at(-1);
      expect(imageMessage?.content).toEqual([
        { type: "text", text: "(image from the tool_call call)" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` },
        },
      ]);
    } finally {
      await fake.server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1 ターンで 5 回を超えてツールを呼べる", async () => {
    const toolCalls = 6;
    const steps: ProviderStep[] = Array.from({ length: toolCalls }, () => ({
      tool: "tool_call",
      args: JSON.stringify({ name: "local_echo", args: { text: "hi" } }),
    }));
    steps.push({ text: "終わりました" });

    const fake = startScriptedProvider(steps);
    const provider = createToolsetProvider();

    try {
      const events = await run(provider, settingsFor(portOf(fake.server)));
      const text = events
        .filter((event): event is Extract<EngineEvent, { type: "text-delta" }> => event.type === "text-delta")
        .map((event) => event.delta)
        .join("");

      expect(provider.executed).toHaveLength(toolCalls);
      expect(callsOf(events, "tool", "call")).toHaveLength(toolCalls);
      expect(fake.bodies).toHaveLength(toolCalls + 1);
      expect(text).toContain("終わりました");
    } finally {
      await fake.server.stop(true);
    }
  });
});

describe("失敗", () => {
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

describe("チャットの UI", () => {
  test("chat_ui はマークアップを検証し、呼び出しと結果がターンへ流れる", async () => {
    const markup = "<Card><Text>確認</Text><Choice><Option>a</Option><Option>b</Option></Choice></Card>";
    const fake = startScriptedProvider([{ tool: "chat_ui", args: JSON.stringify({ markup }) }, { text: "どうぞ" }]);

    try {
      const events = await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)));

      expect(toolNames(fake.bodies[0])).toContain("chat_ui");

      const call = callsOf(events, "chat", "ui")[0];
      if (call === undefined) throw new Error("chat_ui が呼ばれなかった");
      expect(call.part.args).toEqual({ markup });

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(false);
      expect(result.part.output).toContain("The card is shown");
    } finally {
      await fake.server.stop(true);
    }
  });

  test("直せないマークアップは、理由つきの失敗としてモデルへ返る", async () => {
    const fake = startScriptedProvider([
      { tool: "chat_ui", args: JSON.stringify({ markup: "<Card><Nope /></Card>" }) },
      { text: "直します" },
    ]);

    try {
      const events = await run({ toolset: async () => ({}) }, settingsFor(portOf(fake.server)));

      const call = callsOf(events, "chat", "ui")[0];
      if (call === undefined) throw new Error("chat_ui が呼ばれなかった");

      const result = resultOf(events, call.part.id);
      expect(result.part.failed).toBe(true);
      expect(result.part.output).toContain("Invalid UI markup");
    } finally {
      await fake.server.stop(true);
    }
  });
});

describe("途中で届いた発言", () => {
  test("次のステップの直前の user メッセージとしてモデルへ渡る", async () => {
    const fake = startScriptedProvider([
      { tool: "tool_search", args: JSON.stringify({ query: "local" }) },
      { text: "受け取りました" },
    ]);
    const steering: ChatMessage = {
      id: "steering-1",
      teraId: "t1",
      seq: 2,
      role: "user",
      content: "方針を変えてください",
      attachments: null,
      parts: null,
      createdAt: 1,
      usage: null,
    };
    let calls = 0;

    try {
      const stream = await createAiSdkEngine({
        settings: { read: () => settingsFor(portOf(fake.server)) },
        mcp: { toolset: async () => ({}) },
        computer: createComputerStub(),
        attachments: createAttachmentsStub(),
        history: createHistoryStub(),
        webSearch: createWebSearchToolsStub(),
        connections: createConnectionToolsStub(),
        discord: createDiscordToolsStub(),
        tera: createTeraToolsStub(),
        coding: createCodingStub(),
        images: createImageStub(),
        catalog: { snapshot: () => null },
        skills: createSkillFileStoreStub(),
        identity: createIdentityStoreStub(),
      }).stream({
        context: { summary: null, messages: history() },
        signal: new AbortController().signal,
        teraId: "t1",
        replyLanguage: "ja",
        attach: () => undefined,
        takeSteering: () => {
          calls += 1;
          return calls === 1 ? [] : [steering];
        },
      });

      for await (const event of stream.events) {
        if (event.type === "step-limit") throw new Error("ステップの上限に達した");
      }

      expect(fake.bodies).toHaveLength(2);
      expect(JSON.stringify(fake.bodies[0])).not.toContain("方針を変えてください");
      expect(JSON.stringify(fake.bodies[1])).toContain("方針を変えてください");
    } finally {
      await fake.server.stop(true);
    }
  });
});

describe("identity（AI SDK 経由）", () => {
  test("system プロンプトには切り替えた版だけが載り、identity ツールが常に渡る", async () => {
    const fake = startScriptedProvider([{ text: "読みました" }]);
    const identity = createIdentityStoreStub({
      content: "# Role\n書きかけの役割",
      applied: "# Role\n確定した役割",
    });

    try {
      await run(
        { toolset: async () => ({}) },
        settingsFor(portOf(fake.server)),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        identity,
      );

      const body = JSON.stringify(fake.bodies[0]);
      expect(body).toContain("確定した役割");
      expect(body).not.toContain("書きかけの役割");
      expect(toolNames(fake.bodies[0])).toContain("identity");
    } finally {
      await fake.server.stop(true);
    }
  });
});

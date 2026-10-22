import { describe, expect, test } from "bun:test";
import type { ModelSettings } from "../src/server/data/settings-schema";
import { createAiSdkEngine, type SettingsReader } from "../src/server/agent/engine";
import type { ChatMessage } from "../src/shared/types";
import {
  createAttachmentsStub,
  createCodingStub,
  createComputerStub,
  createConnectionToolsStub,
  createHistoryStub,
  createImageStub,
  createMcpStub,
  createSkillFileStoreStub,
  createWebSearchToolsStub,
} from "./support";

/**
 * OpenAI 互換のストリーミング応答を返す偽のプロバイダ。
 * 受け取った本文を記録して、思考強度が実際に載っているかを確かめられるようにする。
 */
function startFakeProvider() {
  const bodies: Record<string, unknown>[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
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

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk({ role: "assistant", content: "こんにちは" }, null));
            controller.enqueue(chunk({}, "stop"));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });

  return { server, bodies };
}

function history(): ChatMessage[] {
  return [
    {
      id: "m1",
      teraId: "t1",
      seq: 1,
      role: "user",
      content: "こんにちは",
      attachments: null,
      parts: null,
      createdAt: 0,
      usage: null,
    },
  ];
}

/** 偽のプロバイダを独自エンドポイントとして指す設定。 */
function settingsFor(port: number, modelOptions: ModelSettings["modelOptions"]): ModelSettings {
  return {
    model: "custom-1/test-model",
    providers: { "custom-1": { baseUrl: `http://127.0.0.1:${port}/v1` } },
    modelOptions,
  };
}

/** 待ち受けているポート。取れなければテストの前提が崩れているので止める。 */
function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("偽のプロバイダのポートが取れていない");
  return server.port;
}

async function runEngine(settings: ModelSettings): Promise<string> {
  const reader: SettingsReader = { read: () => settings };
  const stream = await createAiSdkEngine({
    settings: reader,
    mcp: createMcpStub(),
    computer: createComputerStub(),
    attachments: createAttachmentsStub(),
    history: createHistoryStub(),
    webSearch: createWebSearchToolsStub(),
    connections: createConnectionToolsStub(),
    coding: createCodingStub(),
    images: createImageStub(),
    catalog: { snapshot: () => null },
    skills: createSkillFileStoreStub(),
  }).stream({
    context: { summary: null, messages: history() },
    signal: new AbortController().signal,
    teraId: "t1",
    replyLanguage: "ja",
    attach: () => undefined,
  });

  let text = "";
  for await (const event of stream.events) {
    if (event.type === "text-delta") text += event.delta;
  }
  return text;
}

describe("思考強度の受け渡し（AI SDK 経由）", () => {
  test("設定した思考強度が reasoning_effort として本文に載る", async () => {
    const fake = startFakeProvider();
    try {
      const text = await runEngine(
        settingsFor(portOf(fake.server), { "custom-1/test-model": { reasoningEffort: "high" } }),
      );

      expect(text).toBe("こんにちは");
      expect(fake.bodies).toHaveLength(1);
      expect(fake.bodies[0]).toMatchObject({ model: "test-model", reasoning_effort: "high" });
    } finally {
      await fake.server.stop(true);
    }
  });

  test("思考強度が未設定なら、本文に載せない", async () => {
    const fake = startFakeProvider();
    try {
      await runEngine(settingsFor(portOf(fake.server), {}));

      expect(fake.bodies[0]?.["reasoning_effort"]).toBeUndefined();
    } finally {
      await fake.server.stop(true);
    }
  });

  test("渡せない値が設定に入っていたら、送信の前に止める", async () => {
    const fake = startFakeProvider();
    try {
      const failure = await runEngine(
        settingsFor(portOf(fake.server), { "custom-1/test-model": { reasoningEffort: "とても高い" } }),
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("思考強度");
      // 呼び出しへ進んでいない。
      expect(fake.bodies).toHaveLength(0);
    } finally {
      await fake.server.stop(true);
    }
  });
});

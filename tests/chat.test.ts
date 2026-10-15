import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { AgentEngine, EngineInput, EngineStream } from "../src/server/engine";
import { createMockEngine } from "../src/server/engine";
import { createHandover } from "../src/server/handover";
import { startServer } from "../src/server/server";
import { createStore } from "../src/server/store";
import type { Store } from "../src/server/store";
import { decodeChatEvents } from "../src/shared/sse";
import type { ApiErrorCode, ChatEvent, ChatMessage, Session } from "../src/shared/types";
import { TEST_SETTINGS, createContainerStub, createImageStub, createMcpStub, withTempSettings } from "./support";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0, // 空きポートを OS に選ばせる
  configDir: ".",
  configPath: "./config.json",
  dataDir: ".",
  dbPath: ":memory:",
  engine: "mock",
  isDevelopment: false,
};

/** モックの全文生成が目的なので、待ち時間ゼロで一気に流す。 */
function fastMock() {
  return createMockEngine({ chunkSize: 10_000, delayMs: 0 });
}

type Harness = {
  store: Store;
  request(path: string, init?: RequestInit): Promise<Response>;
  send(sessionId: string, content: string): Promise<ChatEvent[]>;
  sessions(): Promise<Session[]>;
  messages(sessionId: string): Promise<ChatMessage[]>;
};

/**
 * テストごとにサーバを起動して停止する。
 * ストレージはメモリ上、ポートは自動割り当てなのでテスト同士が干渉しない。
 */
async function withServer<T>(engine: AgentEngine, run: (harness: Harness) => Promise<T>): Promise<T> {
  return withTempSettings(TEST_SETTINGS, async (settings) => {
    const store = createStore(":memory:");
    const { server } = startServer({ config, store, engine, settings, mcp: createMcpStub(), container: createContainerStub(), images: createImageStub(), handover: createHandover() });
    const base = server.url;

    const request = (path: string, init?: RequestInit) => fetch(new URL(path, base), init);

    const harness: Harness = {
      store,
      request,
      async send(sessionId, content) {
        const response = await request(`/api/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        expect(response.status, "送信が失敗した").toBe(200);

        const decoded = decodeChatEvents(await response.text());
        expect(decoded.rest).toBe("");
        return decoded.events;
      },
      async sessions() {
        const response = await request("/api/sessions");
        return ((await response.json()) as { sessions: Session[] }).sessions;
      },
      async messages(sessionId) {
        const response = await request(`/api/sessions/${sessionId}/messages`);
        return ((await response.json()) as { messages: ChatMessage[] }).messages;
      },
    };

    try {
      return await run(harness);
    } finally {
      await server.stop(true);
    }
  });
}

function joinedDeltas(events: ChatEvent[]): string {
  return events
    .filter((event): event is Extract<ChatEvent, { type: "text-delta" }> => event.type === "text-delta")
    .map((event) => event.delta)
    .join("");
}

function assistantDone(events: ChatEvent[]): ChatMessage {
  const last = events.at(-1);
  if (last?.type !== "assistant-done") throw new Error("最後のイベントが assistant-done ではない");
  return last.message;
}

function failingEvent(events: ChatEvent[]): { code: ApiErrorCode; detail: string | null } {
  const last = events.at(-1);
  if (last?.type !== "error") throw new Error("最後のイベントが error ではない");
  return { code: last.code, detail: last.detail };
}

/** 記録した入力をあとから検証できるようにするラッパー。 */
function createRecordingEngine(inner: AgentEngine): AgentEngine & { inputs: EngineInput[] } {
  const inputs: EngineInput[] = [];
  return {
    name: `recording(${inner.name})`,
    inputs,
    stream(input) {
      inputs.push(input);
      return inner.stream(input);
    },
  };
}

/** 失敗の伝わり方を確かめるためのエンジン。 */
function createFailingEngine(mode: "immediate" | "mid-stream"): AgentEngine {
  return {
    name: `failing(${mode})`,
    stream(): Promise<EngineStream> {
      if (mode === "immediate") return Promise.reject(new Error("モデルに接続できなかった"));

      return Promise.resolve({
        events: (async function* () {
          yield { type: "text-delta", delta: "部分" } as const;
          yield { type: "text-delta", delta: "的な" } as const;
          throw new Error("途中で切れた");
        })(),
        usage: Promise.resolve(null),
      });
    },
  };
}

/** ツール呼び出しを 1 回挟むターンを流すエンジン。 */
function createToolEngine(): AgentEngine {
  const call = { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } } as const;
  const result = {
    type: "tool-result",
    id: "call-1",
    server: "local",
    tool: "echo",
    failed: false,
    output: "echo: hi",
  } as const;

  return {
    name: "tool-engine",
    stream(): Promise<EngineStream> {
      return Promise.resolve({
        events: (async function* () {
          yield { type: "text-delta", delta: "調べます。" } as const;
          yield { type: "tool-call", part: call } as const;
          yield { type: "tool-result", part: result } as const;
          yield { type: "text-delta", delta: "分かりました。" } as const;
        })(),
        usage: Promise.resolve({ inputTokens: 3, outputTokens: 4, cachedInputTokens: 0 }),
      });
    },
  };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("待機条件が満たされなかった");
}

describe("チャット API", () => {
  test("1 ターンが user-message → assistant-start → text-delta* → assistant-done の順で流れる", async () => {
    await withServer(fastMock(), async (harness) => {
      const events = await harness.send("s1", "こんにちは");

      expect(events[0]?.type).toBe("user-message");
      expect(events[1]?.type).toBe("assistant-start");
      expect(events.slice(2, -1).every((event) => event.type === "text-delta")).toBe(true);

      const done = assistantDone(events);
      expect(joinedDeltas(events)).toBe(done.content);
      expect(done.content.length).toBeGreaterThan(0);
      expect(done.usage).not.toBeNull();
    });
  });

  test("送信のたびにセッションが作られ、二度目は作り直されない", async () => {
    await withServer(fastMock(), async (harness) => {
      await harness.send("s1", "最初のメッセージ");
      await harness.send("s1", "二番目のメッセージ");

      const sessions = await harness.sessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe("最初のメッセージ");
    });
  });

  test("履歴は seq 昇順で、ユーザーとアシスタントが交互に保存される", async () => {
    await withServer(fastMock(), async (harness) => {
      await harness.send("s1", "質問");

      const messages = await harness.messages("s1");
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages.map((message) => message.seq)).toEqual([1, 2]);
      expect(messages[1]?.usage).not.toBeNull();
    });
  });

  test("モデルへ渡る履歴は、前のターンの履歴で始まる（キャッシュが当たる条件）", async () => {
    const recording = createRecordingEngine(fastMock());
    await withServer(recording, async (harness) => {
      await harness.send("s1", "最初の質問");
      await harness.send("s1", "次の質問");

      const [first, second] = recording.inputs;
      if (first === undefined || second === undefined) throw new Error("入力が記録されていない");

      expect(second.history.slice(0, first.history.length)).toEqual([...first.history]);
      expect(JSON.stringify(second.history).startsWith(JSON.stringify(first.history).slice(0, -1))).toBe(true);
    });
  });

  test("ツール呼び出しと結果がイベントとして流れ、本文と一緒に保存される", async () => {
    await withServer(createToolEngine(), async (harness) => {
      const events = await harness.send("s1", "調べて");

      expect(events.map((event) => event.type)).toEqual([
        "user-message",
        "assistant-start",
        "text-delta",
        "tool-call",
        "tool-result",
        "text-delta",
        "assistant-done",
      ]);

      const done = assistantDone(events);
      expect(done.content).toBe("調べます。分かりました。");
      expect(done.parts).toEqual([
        { type: "text", text: "調べます。" },
        { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
        {
          type: "tool-result",
          id: "call-1",
          server: "local",
          tool: "echo",
          failed: false,
          output: "echo: hi",
        },
        { type: "text", text: "分かりました。" },
      ]);

      // 読み直しても同じ並びで戻る。
      const messages = await harness.messages("s1");
      expect(messages[1]?.parts).toEqual(done.parts);
    });
  });

  test("ツールを使わなかったターンは部品を持たない（本文だけ）", async () => {
    await withServer(fastMock(), async (harness) => {
      await harness.send("s1", "こんにちは");

      const messages = await harness.messages("s1");
      expect(messages[1]?.parts).toBeNull();
    });
  });

  test("次のターンの履歴には、前のターンのツール呼び出しと結果が入っている", async () => {
    const recording = createRecordingEngine(createToolEngine());
    await withServer(recording, async (harness) => {
      await harness.send("s1", "調べて");
      await harness.send("s1", "もう一度");

      const second = recording.inputs[1];
      if (second === undefined) throw new Error("2 ターン目の入力が無い");

      expect(second.history[1]?.parts).toEqual([
        { type: "text", text: "調べます。" },
        { type: "tool-call", id: "call-1", server: "local", tool: "echo", args: { text: "hi" } },
        {
          type: "tool-result",
          id: "call-1",
          server: "local",
          tool: "echo",
          failed: false,
          output: "echo: hi",
        },
        { type: "text", text: "分かりました。" },
      ]);
    });
  });

  test("削除するとセッションも履歴も消える", async () => {    await withServer(fastMock(), async (harness) => {
      await harness.send("s1", "消される会話");

      const deleted = await harness.request("/api/sessions/s1", { method: "DELETE" });
      expect(deleted.status).toBe(204);
      expect(await harness.sessions()).toEqual([]);
      // 履歴も一緒に消えているので、参照は 404 になる。
      expect((await harness.request("/api/sessions/s1/messages")).status).toBe(404);
      expect(harness.store.listMessages("s1")).toEqual([]);
    });
  });

  test("空の本文は 400 invalid_request で弾く", async () => {
    await withServer(fastMock(), async (harness) => {
      const response = await harness.request("/api/sessions/s1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "   " }),
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("存在しないセッションの参照は 404 session_not_found", async () => {
    await withServer(fastMock(), async (harness) => {
      const response = await harness.request("/api/sessions/missing/messages");
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("session_not_found");
    });
  });

  test("モデルが即座に失敗したら error を返し、空のメッセージを残さない", async () => {
    await withServer(createFailingEngine("immediate"), async (harness) => {
      const events = await harness.send("s1", "届かない質問");

      expect(failingEvent(events).code).toBe("model_error");
      expect(failingEvent(events).detail).toBe("モデルに接続できなかった");

      const messages = await harness.messages("s1");
      expect(messages.map((message) => message.role)).toEqual(["user"]);
    });
  });

  test("モデルが途中で失敗したら error を返し、そこまでの本文は保存する", async () => {
    await withServer(createFailingEngine("mid-stream"), async (harness) => {
      const events = await harness.send("s1", "途中で切れる質問");

      expect(joinedDeltas(events)).toBe("部分的な");
      expect(failingEvent(events).code).toBe("model_error");

      const messages = await harness.messages("s1");
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[1]?.content).toBe("部分的な");
    });
  });

  test("途中で購読をやめても、生成済みの本文は保存される", async () => {
    // ゆっくり流すエンジンにして、途中でクライアントから切る。
    const slow = createMockEngine({ chunkSize: 2, delayMs: 10 });
    await withServer(slow, async (harness) => {
      const controller = new AbortController();
      const response = await harness.request("/api/sessions/abort-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "長めの応答をください" }),
        signal: controller.signal,
      });

      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("本文が無い");

      // 最初のフレーム（user-message）を受け取ってから、少し生成させて切る。
      await reader.read();
      await new Promise((resolve) => setTimeout(resolve, 80));
      controller.abort();
      await reader.cancel().catch(() => undefined);

      await waitFor(async () => (await harness.messages("abort-1")).length === 2);

      const [user, assistant] = await harness.messages("abort-1");
      if (user === undefined || assistant === undefined) throw new Error("保存されていない");
      expect(assistant.role).toBe("assistant");
      expect(assistant.content.length).toBeGreaterThan(0);

      // 保存された本文は、最後まで生成した場合の接頭辞になっている。
      const reference = createMockEngine({ chunkSize: 10_000, delayMs: 0 });
      const full = await reference.stream({ history: [user], signal: new AbortController().signal, sessionId: "abort-1" });
      let fullText = "";
      for await (const event of full.events) {
        if (event.type === "text-delta") fullText += event.delta;
      }

      expect(fullText.startsWith(assistant.content)).toBe(true);
      expect(assistant.content.length).toBeLessThan(fullText.length);
    });
  });
});

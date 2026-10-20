import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { AgentEngine, EngineInput, EngineStream } from "../src/server/engine";
import { createMockEngine } from "../src/server/engine";
import { createHandover } from "../src/server/handover";
import { startServer } from "../src/server/server";
import { createStore, DEFAULT_TERA_ID } from "../src/server/store";
import type { Store } from "../src/server/store";
import { decodeChatEvents } from "../src/shared/sse";
import type { ApiErrorCode, ChatEvent, ChatMessage, Tera } from "../src/shared/types";
import { TEST_SETTINGS, createCompactionStub, createContainerStub, createMcpStub, withTempSettings } from "./support";

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
  send(teraId: string, content: string): Promise<ChatEvent[]>;
  teras(): Promise<Tera[]>;
  messages(teraId: string): Promise<ChatMessage[]>;
};

/**
 * テストごとにサーバを起動して停止する。
 * ストレージはメモリ上、ポートは自動割り当てなのでテスト同士が干渉しない。
 */
async function withServer<T>(
  engine: AgentEngine,
  run: (harness: Harness) => Promise<T>,
  /**
   * ストアを差し替える（既定はメモリ上の本物）。
   * 読み出しで失敗するストアを混ぜて、想定外の例外の返し方を確かめるために使う。
   */
  makeStore: () => Store = () => createStore(":memory:"),
): Promise<T> {
  return withTempSettings(TEST_SETTINGS, async (settings) => {
    const store = makeStore();
    const compaction = createCompactionStub(store);
    const { server } = startServer({
      config,
      store,
      engine,
      compaction,
      settings,
      mcp: createMcpStub(),
      container: createContainerStub(),
      handover: createHandover(),
    });
    const base = server.url;

    const request = (path: string, init?: RequestInit) => fetch(new URL(path, base), init);

    const harness: Harness = {
      store,
      request,
      async send(teraId, content) {
        const response = await request(`/api/teras/${teraId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, language: "ja" }),
        });
        expect(response.status, "送信が失敗した").toBe(200);

        const decoded = decodeChatEvents(await response.text());
        expect(decoded.rest).toBe("");
        return decoded.events;
      },
      async teras() {
        const response = await request("/api/teras");
        return ((await response.json()) as { teras: Tera[] }).teras;
      },
      async messages(teraId) {
        const response = await request(`/api/teras/${teraId}/messages`);
        return ((await response.json()) as { messages: ChatMessage[] }).messages;
      },
    };

    try {
      return await run(harness);
    } finally {
      await server.stop(true);
      compaction.close();
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
    complete(input) {
      return inner.complete(input);
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
    complete() {
      return Promise.reject(new Error("テスト用のエンジンでは要約を作れません"));
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
    complete() {
      return Promise.reject(new Error("テスト用のエンジンでは要約を作れません"));
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
      const events = await harness.send(DEFAULT_TERA_ID, "こんにちは");

      expect(events[0]?.type).toBe("user-message");
      expect(events[1]?.type).toBe("assistant-start");
      expect(events.slice(2, -1).every((event) => event.type === "text-delta")).toBe(true);

      const done = assistantDone(events);
      expect(joinedDeltas(events)).toBe(done.content);
      expect(done.content.length).toBeGreaterThan(0);
      expect(done.usage).not.toBeNull();
    });
  });

  test("送信しても Tera は増えず、1 本の履歴が伸びる", async () => {
    await withServer(fastMock(), async (harness) => {
      await harness.send(DEFAULT_TERA_ID, "最初のメッセージ");
      await harness.send(DEFAULT_TERA_ID, "二番目のメッセージ");

      const teras = await harness.teras();
      expect(teras.map((tera) => tera.id)).toEqual([DEFAULT_TERA_ID]);

      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    });
  });

  test("会話は Tera ごとに分かれる", async () => {
    await withServer(fastMock(), async (harness) => {
      // いまは画面から Tera を増やせないので、2 体目はストアに直接用意する。
      harness.store.ensureTera("second", "2 体目");

      await harness.send(DEFAULT_TERA_ID, "既定の Tera へ");
      await harness.send("second", "2 体目の Tera へ");

      const userMessagesOf = async (teraId: string) =>
        (await harness.messages(teraId))
          .filter((message) => message.role === "user")
          .map((message) => message.content);

      expect(await userMessagesOf(DEFAULT_TERA_ID)).toEqual(["既定の Tera へ"]);
      expect(await userMessagesOf("second")).toEqual(["2 体目の Tera へ"]);
    });
  });

  test("履歴は seq 昇順で、ユーザーとアシスタントが交互に保存される", async () => {
    await withServer(fastMock(), async (harness) => {
      await harness.send(DEFAULT_TERA_ID, "質問");

      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages.map((message) => message.seq)).toEqual([1, 2]);
      expect(messages[1]?.usage).not.toBeNull();
    });
  });

  test("モデルへ渡る履歴は、前のターンの履歴で始まる（キャッシュが当たる条件）", async () => {
    const recording = createRecordingEngine(fastMock());
    await withServer(recording, async (harness) => {
      await harness.send(DEFAULT_TERA_ID, "最初の質問");
      await harness.send(DEFAULT_TERA_ID, "次の質問");

      const [first, second] = recording.inputs;
      if (first === undefined || second === undefined) throw new Error("入力が記録されていない");

      expect(second.context.messages.slice(0, first.context.messages.length)).toEqual([...first.context.messages]);
      expect(JSON.stringify(second.context.messages).startsWith(JSON.stringify(first.context.messages).slice(0, -1))).toBe(true);
    });
  });

  test("畳んだ要約があるときは、要約と、そのあとの生の履歴が渡る", async () => {
    const recording = createRecordingEngine(fastMock());
    await withServer(recording, async (harness) => {
      await harness.send(DEFAULT_TERA_ID, "最初の質問");

      // 要約は閾値（文脈長から余白を引いた線）まで会話しないと作られない。
      // ここでは作られた後の状態を直接置いて、渡り方だけを確かめる。
      harness.store.writeCompaction(DEFAULT_TERA_ID, {
        summary: "## Goal\n京都に住んでいる。",
        throughSeq: 2,
        tokensBefore: 1_000,
        createdAt: 1,
      });

      await harness.send(DEFAULT_TERA_ID, "次の質問");

      const input = recording.inputs[1];
      if (input === undefined) throw new Error("2 ターン目の入力が無い");
      expect(input.context.summary).toContain("京都に住んでいる");
      expect(input.context.messages.map((message) => message.content)).toEqual(["次の質問"]);
    });
  });

  test("ツール呼び出しと結果がイベントとして流れ、本文と一緒に保存される", async () => {
    await withServer(createToolEngine(), async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "調べて");

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
      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages[1]?.parts).toEqual(done.parts);
    });
  });

  test("ツールを使わなかったターンは部品を持たない（本文だけ）", async () => {
    await withServer(fastMock(), async (harness) => {
      await harness.send(DEFAULT_TERA_ID, "こんにちは");

      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages[1]?.parts).toBeNull();
    });
  });

  test("次のターンの履歴には、前のターンのツール呼び出しと結果が入っている", async () => {
    const recording = createRecordingEngine(createToolEngine());
    await withServer(recording, async (harness) => {
      await harness.send(DEFAULT_TERA_ID, "調べて");
      await harness.send(DEFAULT_TERA_ID, "もう一度");

      const second = recording.inputs[1];
      if (second === undefined) throw new Error("2 ターン目の入力が無い");

      expect(second.context.messages[1]?.parts).toEqual([
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

  test("空の本文は 400 invalid_request で弾く", async () => {
    await withServer(fastMock(), async (harness) => {
      const response = await harness.request(`/api/teras/${DEFAULT_TERA_ID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "   ", language: "ja" }),
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("返事の言語が無い送信は 400 invalid_request で弾く", async () => {
    await withServer(fastMock(), async (harness) => {
      const response = await harness.request(`/api/teras/${DEFAULT_TERA_ID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "こんにちは" }),
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("存在しない Tera は、参照も送信も 404 tera_not_found", async () => {
    await withServer(fastMock(), async (harness) => {
      const response = await harness.request("/api/teras/missing/messages");
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("tera_not_found");

      const posted = await harness.request("/api/teras/missing/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "こんにちは", language: "ja" }),
      });
      expect(posted.status).toBe(404);
      expect(((await posted.json()) as { code: string }).code).toBe("tera_not_found");
    });
  });

  test("同じ Tera で応答を生成している間は、次の送信を 409 で断る", async () => {
    // ゆっくり流し、1 つ目が終わらないうちに 2 つ目を送れるようにする。
    await withServer(createMockEngine({ chunkSize: 1, delayMs: 5 }), async (harness) => {
      const send = (content: string) =>
        harness.request(`/api/teras/${DEFAULT_TERA_ID}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, language: "ja" }),
        });

      const first = await send("1 つ目の質問");
      expect(first.status).toBe(200);

      // 読み切っていないので、まだ生成中。ここで送ると断られる。
      const second = await send("2 つ目の質問");
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("turn_in_progress");

      // 読み切れば、また受け付ける。
      await first.text();
      const third = await send("3 つ目の質問");
      expect(third.status).toBe(200);
      await third.text();

      // 断られた分は履歴に残らない（user だけが 2 件増える）。
      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
        "1 つ目の質問",
        "3 つ目の質問",
      ]);
    });
  });

  test("ハンドラの中で起きた想定外の例外も、JSON の 500 で返す", async () => {
    const base = createStore(":memory:");
    const broken: Store = {
      ...base,
      listTeras() {
        throw new Error("一覧を読めませんでした");
      },
    };

    await withServer(
      fastMock(),
      async (harness) => {
        const response = await harness.request("/api/teras");

        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toEqual({ code: "internal_error", detail: "一覧を読めませんでした" });
      },
      () => broken,
    );
  });

  test("ステップの上限で打ち切られたら、理由を本文の末尾に残す", async () => {
    /** 上限で打ち切られたターンを流すエンジン。 */
    const limitEngine: AgentEngine = {
      name: "limit",
      stream: async () => ({
        events: (async function* () {
          yield { type: "text-delta", delta: "画面を確認しています。" } as const;
          yield { type: "step-limit" } as const;
        })(),
        usage: Promise.resolve(null),
      }),
      complete: () => Promise.reject(new Error("テスト用のエンジンでは要約を作れません")),
    };

    await withServer(limitEngine, async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "操作を続けて");

      expect(joinedDeltas(events)).toContain("画面を確認しています。");
      expect(joinedDeltas(events)).toContain("上限");

      // 保存された本文にも残る（画面を読み直しても、モデルも理由が分かる）。
      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages[1]?.content).toContain("上限");
    });
  });

  test("モデルが即座に失敗したら error を返し、空のメッセージを残さない", async () => {
    await withServer(createFailingEngine("immediate"), async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "届かない質問");

      expect(failingEvent(events).code).toBe("model_error");
      expect(failingEvent(events).detail).toBe("モデルに接続できなかった");

      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages.map((message) => message.role)).toEqual(["user"]);
    });
  });

  test("モデルが途中で失敗したら error を返し、そこまでの本文は保存する", async () => {
    await withServer(createFailingEngine("mid-stream"), async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "途中で切れる質問");

      expect(joinedDeltas(events)).toBe("部分的な");
      expect(failingEvent(events).code).toBe("model_error");

      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[1]?.content).toBe("部分的な");
    });
  });

  test("途中で購読をやめても、生成済みの本文は保存される", async () => {
    // ゆっくり流すエンジンにして、途中でクライアントから切る。
    const slow = createMockEngine({ chunkSize: 2, delayMs: 10 });
    await withServer(slow, async (harness) => {
      const controller = new AbortController();
      const response = await harness.request(`/api/teras/${DEFAULT_TERA_ID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "長めの応答をください", language: "ja" }),
        signal: controller.signal,
      });

      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("本文が無い");

      // 最初のフレーム（user-message）を受け取ってから、少し生成させて切る。
      await reader.read();
      await new Promise((resolve) => setTimeout(resolve, 80));
      controller.abort();
      await reader.cancel().catch(() => undefined);

      await waitFor(async () => (await harness.messages(DEFAULT_TERA_ID)).length === 2);

      const [user, assistant] = await harness.messages(DEFAULT_TERA_ID);
      if (user === undefined || assistant === undefined) throw new Error("保存されていない");
      expect(assistant.role).toBe("assistant");
      expect(assistant.content.length).toBeGreaterThan(0);

      // 保存された本文は、最後まで生成した場合の接頭辞になっている。
      const reference = createMockEngine({ chunkSize: 10_000, delayMs: 0 });
      const full = await reference.stream({
        context: { summary: null, messages: [user] },
        signal: new AbortController().signal,
        teraId: DEFAULT_TERA_ID,
        replyLanguage: "ja",
      });
      let fullText = "";
      for await (const event of full.events) {
        if (event.type === "text-delta") fullText += event.delta;
      }

      expect(fullText.startsWith(assistant.content)).toBe(true);
      expect(assistant.content.length).toBeLessThan(fullText.length);
    });
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentEngine, EngineInput, EngineStream } from "../src/server/agent/engine";
import { createMockEngine } from "../src/server/agent/engine";
import { userContentForModel } from "../src/server/agent/model-content";
import type { ContainerManager } from "../src/server/computer/container";
import type { Catalog } from "../src/server/provider/catalog";
import { parseCatalog } from "../src/server/provider/catalog";
import { DEFAULT_TERA_ID, createStore } from "../src/server/data/store";
import type { Store } from "../src/server/data/store";
import { MAX_ATTACHMENTS } from "../src/shared/attachments";
import { decodeChatEvents } from "../src/shared/sse";
import type {
  ApiErrorCode,
  AttachmentPart,
  ChatEvent,
  ChatMessage,
  SentAttachment,
  TextPart,
  Tera,
} from "../src/shared/types";
import { fastMock, withServer as withTestServer } from "./harness";
import { createContainerStub } from "./support";

/** テスト用のカタログ。TEST_SETTINGS の deepseek を解決できるようにする。 */
function testCatalog(): Catalog {
  const snapshot = parseCatalog(
    {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.deepseek.com",
        models: { "deepseek-flash": { id: "deepseek-flash", name: "DeepSeek Flash" } },
      },
    },
    1_000,
  );
  return { snapshot: () => snapshot, load: async () => snapshot };
}

type Harness = {
  store: Store;
  request(path: string, init?: RequestInit): Promise<Response>;
  send(teraId: string, content: string, files?: readonly File[]): Promise<ChatEvent[]>;
  teras(): Promise<Tera[]>;
  messages(teraId: string): Promise<ChatMessage[]>;
};

/** 送信の multipart を組み立てる。本文と言語、ファイルを 1 つの要求にまとめる。 */
function messageRequest(
  content: string,
  options: { language?: string | null; files?: readonly File[]; signal?: AbortSignal } = {},
): RequestInit {
  const language = options.language === undefined ? "ja" : options.language;
  const form = new FormData();
  form.append("content", content);
  if (language !== null) form.append("language", language);
  for (const file of options.files ?? []) form.append("files", file, file.name);

  return {
    method: "POST",
    body: form,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/** 書き込まれたパスと中身を記録する、動いているコンテナの差し替え。 */
function recordingContainer(): ContainerManager & { writes: { path: string; bytes: Uint8Array }[] } {
  const writes: { path: string; bytes: Uint8Array }[] = [];

  return {
    ...createContainerStub({ vncPort: 45_678 }),
    async writeFile(path, content) {
      writes.push({ path, bytes: content });
    },
    writes,
  };
}

type TestServerOptions = {
  /** 読み出しで失敗するストアなどに差し替える。 */
  makeStore?: () => Store;
  /** ファイルの書き込みを確かめるときに差し替える。 */
  container?: ContainerManager;
};

/**
 * テストごとにサーバを起動して停止する。
 * ストレージはメモリ上、ポートは自動割り当てなのでテスト同士が干渉しない。
 */
async function withServer<T>(
  engine: AgentEngine,
  run: (harness: Harness) => Promise<T>,
  options: TestServerOptions = {},
): Promise<T> {
  const store = options.makeStore?.() ?? createStore(":memory:");

  return withTestServer(
    async ({ request }) => {
      const harness: Harness = {
        store,
        request,
        async send(teraId, content, files = []) {
          const response = await request(`/api/teras/${teraId}/messages`, messageRequest(content, { files }));
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

      return run(harness);
    },
    {
      engine,
      store,
      catalog: testCatalog(),
      ...(options.container === undefined ? {} : { container: options.container }),
    },
  );
}

/** 画面に流れた本文を、届いた順につなぐ。 */
function visibleText(events: ChatEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "assistant-message" && event.part.type === "text") text += event.part.text;
  }
  return text;
}

/** 保存されたメッセージから、本文のパーツだけを取り出す。 */
function textParts(message: ChatMessage): TextPart[] {
  if (message.parts === null) return [];
  return message.parts.filter((part): part is TextPart => part.type === "text");
}

/** 保存されたメッセージから、添付のパーツだけを取り出す。 */
function attachmentParts(message: ChatMessage): AttachmentPart[] {
  if (message.parts === null) return [];
  return message.parts.filter((part): part is AttachmentPart => part.type === "attachment");
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

/** ツール呼び出しの前後で本文を流すエンジン。 */
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

/** メッセージを少しずつ送り続けるエンジン。途中で切ったときの保存を見る。 */
function createSlowMessageEngine(): AgentEngine {
  return {
    name: "slow-messages",
    stream(input): Promise<EngineStream> {
      return Promise.resolve({
        events: (async function* () {
          for (let index = 0; index < 50; index += 1) {
            if (input.signal.aborted) return;
            yield { type: "text-delta", delta: `${index},` } as const;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        })(),
        usage: Promise.resolve(null),
      });
    },
    complete() {
      return Promise.reject(new Error("テスト用のエンジンでは要約を作れません"));
    },
  };
}

/** 1 件送ったあと、停止されるまで待つエンジン。 */
function createStoppableEngine(): AgentEngine {
  return {
    name: "stoppable",
    stream(input): Promise<EngineStream> {
      return Promise.resolve({
        events: (async function* () {
          yield { type: "text-delta", delta: "途中です。" } as const;
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) {
              resolve();
              return;
            }
            input.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
        usage: Promise.resolve(null),
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
  test("1 ターンが user-message → assistant-start → assistant-message → assistant-done の順で流れる", async () => {
    await withServer(fastMock(), async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "こんにちは");

      expect(events.map((event) => event.type)).toEqual([
        "user-message",
        "assistant-start",
        "assistant-message",
        "assistant-done",
      ]);

      const done = assistantDone(events);
      const visible = textParts(done);
      expect(visible).toHaveLength(1);
      expect(visibleText(events)).toBe(visible[0]?.text ?? "");
      expect(visibleText(events).length).toBeGreaterThan(0);
      // モデルの本文は画面に出さないので、assistant の content は常に空。
      expect(done.content).toBe("");
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
        (await harness.messages(teraId)).filter((message) => message.role === "user").map((message) => message.content);

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
      expect(
        JSON.stringify(second.context.messages).startsWith(JSON.stringify(first.context.messages).slice(0, -1)),
      ).toBe(true);
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

  test("送ったメッセージとツールの呼び出しが、届いた順に保存される", async () => {
    await withServer(createToolEngine(), async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "調べて");

      expect(events.map((event) => event.type)).toEqual([
        "user-message",
        "assistant-start",
        "assistant-message",
        "tool-call",
        "tool-result",
        "assistant-message",
        "assistant-done",
      ]);

      const done = assistantDone(events);
      const parts = done.parts ?? [];
      expect(parts.map((part) => part.type)).toEqual(["text", "tool-call", "tool-result", "text"]);
      expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "調べます。",
        "分かりました。",
      ]);
      expect(done.content).toBe("");

      // 読み直しても同じ並びで戻る。
      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages[1]?.parts).toEqual(done.parts);
    });
  });

  test("本文は parts の text として保存され、content は空になる", async () => {
    await withServer(fastMock(), async (harness) => {
      await harness.send(DEFAULT_TERA_ID, "こんにちは");

      const [user, assistant] = await harness.messages(DEFAULT_TERA_ID);
      expect(user?.content).toBe("こんにちは");
      if (assistant === undefined) throw new Error("assistant のメッセージが無い");
      expect(assistant.content).toBe("");
      expect(textParts(assistant)).toHaveLength(1);
    });
  });

  test("次のターンの履歴には、前のターンの本文とツールの記録が入っている", async () => {
    const recording = createRecordingEngine(createToolEngine());
    await withServer(recording, async (harness) => {
      await harness.send(DEFAULT_TERA_ID, "調べて");
      await harness.send(DEFAULT_TERA_ID, "もう一度");

      const second = recording.inputs[1];
      if (second === undefined) throw new Error("2 ターン目の入力が無い");

      const assistant = second.context.messages[1];
      if (assistant === undefined) throw new Error("assistant の記録が無い");
      expect(assistant.parts?.map((part) => part.type)).toEqual(["text", "tool-call", "tool-result", "text"]);
    });
  });

  test("空の本文は 400 invalid_request で弾く", async () => {
    await withServer(fastMock(), async (harness) => {
      const response = await harness.request(`/api/teras/${DEFAULT_TERA_ID}/messages`, messageRequest("   "));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("添付したファイルがコンテナに置かれ、UI とモデルで本文を分ける", async () => {
    const container = recordingContainer();

    await withServer(
      fastMock(),
      async (harness) => {
        const file = new File([new TextEncoder().encode("hello attachment")], "notes.txt", {
          type: "text/plain",
        });

        const events = await harness.send(DEFAULT_TERA_ID, "このファイルを見て", [file]);

        expect(events[0]?.type).toBe("user-message");
        if (events[0]?.type !== "user-message") throw new Error("最初のイベントが user-message ではない");

        const message = events[0].message;
        expect(message.content).toBe("このファイルを見て");
        expect(message.content).not.toContain("[Attached files]");

        const attachment = message.attachments?.[0];
        if (attachment === undefined) throw new Error("添付ファイルが記録されていない");
        expect(attachment.name).toBe("notes.txt");
        expect(attachment.size).toBe(file.size);
        expect(attachment.path).toMatch(/^\/home\/agent\/uploads\/.+\/01-notes\.txt$/);

        const modelText = userContentForModel(message);
        expect(modelText).toContain("[Attached files]");
        expect(modelText).toContain("notes.txt");
        expect(modelText).toContain(attachment.path);

        const write = container.writes[0];
        if (write === undefined) throw new Error("ファイルが書かれていない");
        expect(write.path.startsWith("/home/agent/uploads/")).toBe(true);
        expect(write.path.endsWith("/01-notes.txt")).toBe(true);
        expect(new TextDecoder().decode(write.bytes)).toBe("hello attachment");

        // 保存された発言にも同じ分離が残り、次のターンでもパスを参照できる。
        const messages = await harness.messages(DEFAULT_TERA_ID);
        expect(messages[0]).toEqual(message);
      },
      { container },
    );
  });

  test("添付ファイルのパスは、モデルへ渡る文脈に入り、画面の本文には入らない", async () => {
    const recording = createRecordingEngine(fastMock());
    const container = recordingContainer();

    await withServer(
      recording,
      async (harness) => {
        const file = new File([new TextEncoder().encode("hello")], "context.txt");
        await harness.send(DEFAULT_TERA_ID, "見て", [file]);

        const input = recording.inputs[0];
        if (input === undefined) throw new Error("入力が記録されていない");

        const message = input.context.messages[0];
        if (message === undefined) throw new Error("ユーザー発言が無い");
        expect(message.content).toBe("見て");
        expect(message.content).not.toContain("context.txt");

        const attachment = message.attachments?.[0];
        if (attachment === undefined) throw new Error("添付ファイルが記録されていない");
        const modelText = userContentForModel(message);
        expect(modelText).toContain("context.txt");
        expect(modelText).toContain(attachment.path);
      },
      { container },
    );
  });

  test("本文が空でもファイルだけを送れる", async () => {
    const container = recordingContainer();

    await withServer(
      fastMock(),
      async (harness) => {
        const file = new File([new TextEncoder().encode("only")], "only.txt");
        const events = await harness.send(DEFAULT_TERA_ID, "", [file]);

        expect(events[0]?.type).toBe("user-message");
        if (events[0]?.type !== "user-message") throw new Error("最初のイベントが user-message ではない");

        const message = events[0].message;
        expect(message.content).toBe("");

        const attachment = message.attachments?.[0];
        if (attachment === undefined) throw new Error("添付ファイルが記録されていない");
        expect(attachment.name).toBe("only.txt");
        expect(attachment.size).toBe(file.size);

        const modelText = userContentForModel(message);
        expect(modelText).toContain("[Attached files]");
        expect(modelText).toContain("only.txt");
        expect(modelText).toContain(attachment.path);
        expect(events.at(-1)?.type).toBe("assistant-done");
      },
      { container },
    );
  });

  test("添付できる数を超えた送信は 400 で弾く", async () => {
    await withServer(fastMock(), async (harness) => {
      const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => new File(["x"], `${index}.txt`));
      const response = await harness.request(
        `/api/teras/${DEFAULT_TERA_ID}/messages`,
        messageRequest("見て", { files }),
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("返事の言語が無い送信は 400 invalid_request で弾く", async () => {
    await withServer(fastMock(), async (harness) => {
      const response = await harness.request(
        `/api/teras/${DEFAULT_TERA_ID}/messages`,
        messageRequest("こんにちは", { language: null }),
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("存在しない Tera は、参照も送信も 404 tera_not_found", async () => {
    await withServer(fastMock(), async (harness) => {
      const response = await harness.request("/api/teras/missing/messages");
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("tera_not_found");

      const posted = await harness.request("/api/teras/missing/messages", messageRequest("こんにちは"));
      expect(posted.status).toBe(404);
      expect(((await posted.json()) as { code: string }).code).toBe("tera_not_found");
    });
  });

  test("同じ Tera で応答を生成している間は、次の送信を 409 で断る", async () => {
    // ゆっくり考えさせ、1 つ目が終わらないうちに 2 つ目を送れるようにする。
    await withServer(createMockEngine({ chunkSize: 1, delayMs: 5 }), async (harness) => {
      const send = (content: string) =>
        harness.request(`/api/teras/${DEFAULT_TERA_ID}/messages`, messageRequest(content));

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

  test("停止を頼むと、それまでに送ったメッセージを保存して assistant-done で終わる", async () => {
    await withServer(createStoppableEngine(), async (harness) => {
      const response = await harness.request(
        `/api/teras/${DEFAULT_TERA_ID}/messages`,
        messageRequest("止めてください"),
      );
      expect(response.status).toBe(200);

      // 本文を読み始めて生成を進め、届いたころに止める。
      const body = response.text();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stopped = await harness.request(`/api/teras/${DEFAULT_TERA_ID}/stop`, { method: "POST" });
      expect(stopped.status).toBe(204);

      const decoded = decodeChatEvents(await body);
      expect(decoded.rest).toBe("");
      const done = assistantDone(decoded.events);
      expect(visibleText(decoded.events)).toBe("途中です。");
      expect(textParts(done).map((part) => part.text)).toEqual(["途中です。"]);
      expect(done.content).toBe("");
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
      { makeStore: () => broken },
    );
  });

  test("ステップの上限で打ち切られたら、画面に注記を残す", async () => {
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

      expect(visibleText(events)).toContain("画面を確認しています。");
      const notice = events.find((event) => event.type === "notice");
      if (notice?.type !== "notice") throw new Error("注記が流れなかった");
      expect(notice.part.text).toContain("上限");

      // 保存された parts にも残る（画面を読み直しても理由が分かる）。
      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages[1]?.parts?.some((part) => part.type === "notice")).toBe(true);
      expect(messages[1]?.content).toBe("");
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

  test("モデルが途中で失敗したら error を返し、そこまでに送ったメッセージは保存する", async () => {
    await withServer(createFailingEngine("mid-stream"), async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "途中で切れる質問");

      expect(visibleText(events)).toBe("部分");
      expect(failingEvent(events).code).toBe("model_error");

      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[1]?.content).toBe("");
      expect(textParts(messages[1] ?? messages[0]!).map((part) => part.text)).toEqual(["部分"]);
    });
  });

  test("本文だけで終わったターンも、その本文を画面に届ける", async () => {
    const textOnly: AgentEngine = {
      name: "text-only",
      stream: async () => ({
        events: (async function* () {
          yield { type: "text-delta", delta: "本文だけの返事" } as const;
        })(),
        usage: Promise.resolve(null),
      }),
      complete: () => Promise.reject(new Error("テスト用のエンジンでは要約を作れません")),
    };

    await withServer(textOnly, async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "返事をください");

      expect(events.at(-1)?.type).toBe("assistant-done");
      expect(visibleText(events)).toBe("本文だけの返事");

      const messages = await harness.messages(DEFAULT_TERA_ID);
      const assistant = messages[1];
      if (assistant === undefined) throw new Error("assistant のメッセージが無い");
      expect(assistant.content).toBe("");
      expect(textParts(assistant).map((part) => part.text)).toEqual(["本文だけの返事"]);
    });
  });

  test("何も書かずに終わったターンは、黙って終わらせずに失敗させる", async () => {
    const silent: AgentEngine = {
      name: "silent",
      stream: async () => ({
        events: (async function* () {})(),
        usage: Promise.resolve(null),
      }),
      complete: () => Promise.reject(new Error("テスト用のエンジンでは要約を作れません")),
    };

    await withServer(silent, async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "返事をください");
      const failure = failingEvent(events);
      expect(failure.code).toBe("model_error");
      expect(failure.detail).toContain("without writing a reply");

      // 何も無いターンは、空のメッセージを残さない。
      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages.map((message) => message.role)).toEqual(["user"]);
    });
  });

  test("添付は attachment パートとして流れ、保存される", async () => {
    const attachment: SentAttachment = {
      name: "screenshot.png",
      size: 3,
      url: "/api/images/x.png",
      image: { width: 4, height: 3 },
    };
    const call = {
      type: "tool-call",
      id: "call-1",
      server: "chat",
      tool: "attach",
      args: {},
    } as const;
    const result = {
      type: "tool-result",
      id: "call-1",
      server: "chat",
      tool: "attach",
      failed: false,
      output: "Attached 1 file to the chat.",
    } as const;

    const withAttachment: AgentEngine = {
      name: "attachment",
      stream: async (input) => ({
        events: (async function* () {
          yield { type: "text-delta", delta: "画面です。" } as const;
          yield { type: "tool-call", part: call } as const;
          input.attach([attachment]);
          yield { type: "tool-result", part: result } as const;
        })(),
        usage: Promise.resolve(null),
      }),
      complete: () => Promise.reject(new Error("テスト用のエンジンでは要約を作れません")),
    };

    await withServer(withAttachment, async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "画面を見せて");

      expect(events.map((event) => event.type)).toEqual([
        "user-message",
        "assistant-start",
        "assistant-message",
        "tool-call",
        "assistant-message",
        "tool-result",
        "assistant-done",
      ]);
      expect(visibleText(events)).toBe("画面です。");

      const messages = await harness.messages(DEFAULT_TERA_ID);
      const assistant = messages[1];
      if (assistant === undefined) throw new Error("assistant のメッセージが無い");
      expect(attachmentParts(assistant)).toEqual([
        { type: "attachment", attachments: [attachment], at: expect.any(Number) },
      ]);
    });
  });

  test("UI カードだけのターンも、空の応答として扱わない", async () => {
    const call = {
      type: "tool-call",
      id: "call-ui",
      server: "chat",
      tool: "ui",
      args: { markup: "<Card><Text>選んでください</Text></Card>" },
    } as const;
    const result = {
      type: "tool-result",
      id: "call-ui",
      server: "chat",
      tool: "ui",
      failed: false,
      output: "The card is shown in the chat.",
    } as const;

    const withUi: AgentEngine = {
      name: "ui",
      stream: async () => ({
        events: (async function* () {
          yield { type: "tool-call", part: call } as const;
          yield { type: "tool-result", part: result } as const;
        })(),
        usage: Promise.resolve(null),
      }),
      complete: () => Promise.reject(new Error("テスト用のエンジンでは要約を作れません")),
    };

    await withServer(withUi, async (harness) => {
      const events = await harness.send(DEFAULT_TERA_ID, "カードを出して");

      // 本文が無くても、カードを出したターンを「何も書かなかった」と扱わない。
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)?.type).toBe("assistant-done");

      const messages = await harness.messages(DEFAULT_TERA_ID);
      expect(messages).toHaveLength(2);
      expect(messages[1]?.parts?.map((part) => part.type)).toEqual(["tool-call", "tool-result"]);
    });
  });

  test("途中で購読をやめても、そこまでに書いた本文は保存される", async () => {
    await withServer(createSlowMessageEngine(), async (harness) => {
      const controller = new AbortController();
      const response = await harness.request(
        `/api/teras/${DEFAULT_TERA_ID}/messages`,
        messageRequest("長めの応答をください", { signal: controller.signal }),
      );

      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("本文が無い");

      // 最初のフレームを受け取ってから、少し送らせて切る。
      await reader.read();
      await new Promise((resolve) => setTimeout(resolve, 80));
      controller.abort();
      await reader.cancel().catch(() => undefined);

      await waitFor(async () => (await harness.messages(DEFAULT_TERA_ID)).length === 2);

      const [user, assistant] = await harness.messages(DEFAULT_TERA_ID);
      if (user === undefined || assistant === undefined) throw new Error("保存されていない");
      expect(assistant.role).toBe("assistant");
      expect(assistant.content).toBe("");

      const saved = textParts(assistant)
        .map((part) => part.text)
        .join("");
      const full = Array.from({ length: 50 }, (_, index) => `${index},`).join("");
      expect(saved.length).toBeGreaterThan(0);
      // 最後まで流したわけではないので、途中で止まったことが分かる。
      expect(saved.length).toBeLessThan(full.length);
    });
  });
});

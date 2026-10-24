import { describe, expect, test } from "bun:test";
import type { AgentEngine, EngineEvent } from "../src/server/agent/engine";
import { DEFAULT_TERA_ID } from "../src/server/data/store";
import { parseCatalog, type Catalog } from "../src/server/provider/catalog";
import { CLIENT_HEADER, type ConversationEvent } from "../src/shared/api/events";
import { decodeChatEvents, decodeConversationEvents } from "../src/shared/sse";
import { type ServerHarness, withServer as withRawServer } from "./harness";
import { TEST_CLIENT } from "./support";

/**
 * 同じ Tera を開いているもう 1 つの画面から見た、会話の購読（GET /api/teras/:id/events）。
 * 送信・割り込み・切断が、ほかの画面へどう届くかを確かめる。
 */

const TERA = DEFAULT_TERA_ID;

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

/** カタログを渡してサーバを起こす（送信がモデルの解決まで進むように）。 */
function withServer<T>(
  run: (harness: ServerHarness) => Promise<T>,
  options: { engine?: AgentEngine } = {},
): Promise<T> {
  return withRawServer(run, { catalog: testCatalog(), ...options });
}

/** 送信の multipart。画面の id はヘッダで伝える。 */
function messageRequest(content: string, clientId: string, signal?: AbortSignal): RequestInit {
  const form = new FormData();
  form.append("content", content);
  form.append("language", "ja");
  return {
    method: "POST",
    body: form,
    headers: { [CLIENT_HEADER]: clientId },
    ...(signal === undefined ? {} : { signal }),
  };
}

/** 割り込みの multipart。 */
function steerRequest(content: string, clientId: string): RequestInit {
  const form = new FormData();
  form.append("content", content);
  return { method: "POST", body: form, headers: { [CLIENT_HEADER]: clientId } };
}

type LiveEvents = {
  /** 次のイベントを 1 つ取り出す（届くまで待つ）。 */
  take(): Promise<ConversationEvent>;
  /** 指定した時間だけ待って、届かなければ null。 */
  tryTake(ms: number): Promise<ConversationEvent | null>;
  close(): Promise<void>;
};

/** 購読の応答を裏で読み続け、届いた順に取り出せるようにする。 */
function liveEvents(response: Response): LiveEvents {
  const body = response.body;
  if (body === null) throw new Error("購読の応答に本文がありません");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const received: ConversationEvent[] = [];
  const waiters: (() => void)[] = [];
  let rest = "";

  const wake = (): void => {
    for (const resolve of waiters.splice(0)) resolve();
  };

  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;

        rest += decoder.decode(chunk.value, { stream: true });
        const decoded = decodeConversationEvents(rest);
        rest = decoded.rest;
        received.push(...decoded.events);
        wake();
      }
    } catch {
      // 読み取りをやめた（後始末）。
    }
  })();

  return {
    async take() {
      for (;;) {
        const event = received.shift();
        if (event !== undefined) return event;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    async tryTake(ms) {
      const deadline = Date.now() + ms;
      for (;;) {
        const event = received.shift();
        if (event !== undefined) return event;

        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    async close() {
      await reader.cancel();
    },
  };
}

/** その Tera の購読を開き、最初の sync まで読む。 */
async function openEvents(harness: ServerHarness, clientId: string): Promise<LiveEvents> {
  const response = await harness.request(`/api/teras/${TERA}/events`, {
    headers: { [CLIENT_HEADER]: clientId },
  });
  expect(response.status).toBe(200);
  return liveEvents(response);
}

/** イベントの種類だけを取り出す。 */
function typesOf(events: readonly ConversationEvent[]): string[] {
  return events.map((event) => event.type);
}

/** 画面に出る本文だけをつなぐ。 */
function textOf(events: readonly ConversationEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "assistant-message" && event.part.type === "text") text += event.part.text;
  }
  return text;
}

/**
 * モデル呼び出しを待たせ、ターンの途中の状態を作るエンジン。
 * started はモデル呼び出しが始まったとき（assistant-start が流れたあと）に解決する。
 * 待っている間、ターンが止められたら（切断・停止）そこで待つのをやめる。
 */
function gatedEngine(): AgentEngine & { started: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  return {
    name: "gated",
    started,
    release,
    async stream({ signal }) {
      markStarted();
      await Promise.race([released, aborted(signal)]);

      return {
        events: (async function* (): AsyncGenerator<EngineEvent> {
          // 止められていたら、何も書かずに終わる（切断されたターンと同じ）。
          if (signal.aborted) return;
          yield { type: "text-delta", delta: "こんにちは" };
        })(),
        usage: Promise.resolve({ inputTokens: 3, outputTokens: 5, cachedInputTokens: 0 }),
      };
    },
    complete() {
      return Promise.resolve("");
    },
  };
}

/** signal が立ったら解決する待ち。 */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** 送り主の応答を読み切らないまま、ターンを走らせておく。 */
function startTurn(harness: ServerHarness, content: string, clientId: string, signal?: AbortSignal): Promise<Response> {
  return harness.request(`/api/teras/${TERA}/messages`, messageRequest(content, clientId, signal));
}

describe("会話の購読", () => {
  test("最初に、保存済みの最新の連番と、ターンが走っているかを返す", async () => {
    await withServer(async (harness) => {
      const empty = await openEvents(harness, "watcher");
      expect(await empty.take()).toEqual({ type: "sync", lastSeq: 0, turnRunning: false });
      await empty.close();

      const sent = await harness.request(`/api/teras/${TERA}/messages`, messageRequest("こんにちは", TEST_CLIENT));
      await sent.text();

      const after = await openEvents(harness, "watcher");
      // ユーザー発言と assistant の発言で 2 件。
      expect(await after.take()).toEqual({ type: "sync", lastSeq: 2, turnRunning: false });
      await after.close();
    });
  });

  test("ほかの画面で始まったターンの出来事が、送った画面と同じ順で流れてくる", async () => {
    await withServer(async (harness) => {
      const watcher = await openEvents(harness, "watcher");
      expect(await watcher.take()).toMatchObject({ type: "sync" });

      const sending = startTurn(harness, "こんにちは", "sender");
      const events: ConversationEvent[] = [];
      for (;;) {
        const event = await watcher.take();
        events.push(event);
        if (event.type === "assistant-done") break;
      }

      const own = decodeChatEvents(await (await sending).text()).events;
      expect(typesOf(events)).toEqual(own.map((event) => event.type));
      expect(textOf(events)).toBe(textOf(own));
      expect(events[0]).toMatchObject({ type: "user-message", message: { content: "こんにちは" } });

      await watcher.close();
    });
  });

  test("送った画面の購読には、自分の送信を配らない", async () => {
    await withServer(async (harness) => {
      const own = await openEvents(harness, "sender");
      expect(await own.take()).toMatchObject({ type: "sync", turnRunning: false });

      const sending = await harness.request(`/api/teras/${TERA}/messages`, messageRequest("こんにちは", "sender"));
      await sending.text();

      // 自分の出来事は、送信の応答として受け取っている。購読には溜まっていない。
      expect(await own.tryTake(100)).toBeNull();
      await own.close();
    });
  });

  test("ターンの途中から購読しても、始まったところから流れてくる", async () => {
    const engine = gatedEngine();
    await withServer(
      async (harness) => {
        const sending = startTurn(harness, "こんにちは", "sender");
        // ターンが始まり、モデルの応答を待っているところまで進める。
        await engine.started;

        const late = await openEvents(harness, "watcher");
        // 応答の行は開始時に予約されているので、最新の連番はその分まで進んでいる。
        expect(await late.take()).toEqual({ type: "sync", lastSeq: 2, turnRunning: true });
        expect(await late.take()).toMatchObject({ type: "assistant-start" });

        engine.release();

        // 途中からでも、始まったところから続きが流れる。
        const rest: ConversationEvent[] = [await late.take()];
        for (;;) {
          const event = await late.take();
          rest.push(event);
          if (event.type === "assistant-done") break;
        }
        expect(textOf(rest)).toBe("こんにちは");

        await (await sending).text();
        await late.close();
      },
      { engine },
    );
  });

  test("応答中の割り込みは、ほかの画面へも発言として流れる", async () => {
    const engine = gatedEngine();
    await withServer(
      async (harness) => {
        const watcher = await openEvents(harness, "watcher");
        expect(await watcher.take()).toMatchObject({ type: "sync" });

        const sending = startTurn(harness, "こんにちは", "sender");
        await engine.started;
        // ターンの始まり（送った画面の発言と、応答の開始）は、購読にも流れている。
        expect(await watcher.take()).toMatchObject({ type: "user-message", message: { content: "こんにちは" } });
        expect(await watcher.take()).toMatchObject({ type: "assistant-start" });

        const steered = await harness.request(`/api/teras/${TERA}/steer`, steerRequest("あとから足す", "other"));
        expect(steered.status).toBe(200);

        const event = await watcher.take();
        expect(event).toMatchObject({ type: "user-message", message: { content: "あとから足す" } });

        engine.release();
        await (await sending).text();
        await watcher.close();
      },
      { engine },
    );
  });

  test("送った画面が離れても、ターンは続いて終わりまで流れる", async () => {
    const engine = gatedEngine();
    await withServer(
      async (harness) => {
        const watcher = await openEvents(harness, "watcher");
        expect(await watcher.take()).toMatchObject({ type: "sync", turnRunning: false });

        const controller = new AbortController();
        const sending = startTurn(harness, "こんにちは", "sender", controller.signal).catch(() => null);
        await engine.started;

        // 送った画面が離れる（タブを閉じる、表示する Tera を切り替える）。
        controller.abort();
        await sending;

        // 離れたあとに本文が届いても、ターンは最後まで走る。
        engine.release();

        const seen: string[] = [];
        for (;;) {
          const event = await watcher.take();
          seen.push(event.type);
          if (event.type === "assistant-done") break;
        }
        expect(seen).toEqual(["user-message", "assistant-start", "assistant-message", "assistant-done"]);

        // ターンは終わっているので、次に開いた画面には走っていないと伝える。
        const after = await openEvents(harness, "watcher2");
        expect(await after.take()).toMatchObject({ type: "sync", turnRunning: false });
        await after.close();
        await watcher.close();
      },
      { engine },
    );
  }, 15_000);

  test("画面の id が無い要求は、本文を読む前に 400 で断る", async () => {
    await withServer(async (harness) => {
      const form = new FormData();
      form.append("content", "こんにちは");
      form.append("language", "ja");

      const sending = await harness.request(`/api/teras/${TERA}/messages`, { method: "POST", body: form });
      expect(sending.status).toBe(400);
      expect(((await sending.json()) as { code: string }).code).toBe("invalid_request");

      const steering = await harness.request(`/api/teras/${TERA}/steer`, { method: "POST", body: form });
      expect(steering.status).toBe(400);

      const events = await harness.request(`/api/teras/${TERA}/events`);
      expect(events.status).toBe(400);

      // 断った送信は、履歴にもターンにも残らない。
      expect(harness.store.lastSeq(TERA)).toBe(0);
    });
  });

  test("無い Tera の購読は 404", async () => {
    await withServer(async (harness) => {
      const response = await harness.request("/api/teras/missing/events", {
        headers: { [CLIENT_HEADER]: "watcher" },
      });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("tera_not_found");
    });
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentEngine, EngineEvent } from "../src/server/agent/engine";
import { createConversationBroadcast } from "../src/server/conversation/broadcast";
import { createMockEngine } from "../src/server/agent/engine/mock";
import { createTurns, type Turns } from "../src/server/conversation/turns";
import { createStore, type Store } from "../src/server/data/store";
import type { FileSettings } from "../src/server/data/settings";
import { parseCatalog, type Catalog } from "../src/server/provider/catalog";
import { createRoutineScheduler, type RoutineScheduler } from "../src/server/routine/scheduler";
import type { ChatEvent } from "../src/shared/api/message";
import { createCompactionStub, TEST_SETTINGS, withTempSettings } from "./support";

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

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("待っても条件が満たされませんでした");
}

/** ターンを最後まで読む。 */
async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** signal が立ったら解決する待ち。 */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * モデル呼び出しを待たせ、ターンの途中の状態を作るエンジン。
 * started はモデル呼び出しが始まったときに解決し、release で応答を流し始める。
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
    started,
    release,
    async stream({ signal }) {
      markStarted();
      await Promise.race([released, aborted(signal)]);

      return {
        events: (async function* (): AsyncGenerator<EngineEvent> {
          // 止められていたら、何も書かずに終わる。
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

type Harness = { store: Store; turns: Turns; scheduler: RoutineScheduler };

/** スケジューラを、テスト用の時計と短い tick で組み立てる。 */
async function withScheduler(
  options: { settings: FileSettings; now: () => number; engine?: AgentEngine },
  run: (harness: Harness & { close(): void }) => Promise<void>,
): Promise<void> {
  await withTempSettings(options.settings, async (settings) => {
    const store = createStore(":memory:", { now: options.now });
    const compaction = createCompactionStub(store);
    const engine = options.engine ?? createMockEngine({ chunkSize: 10_000, delayMs: 0 });
    const turns = createTurns({ store, engine, compaction });
    const broadcast = createConversationBroadcast();
    const scheduler = createRoutineScheduler({
      store,
      turns,
      broadcast,
      settings,
      catalog: testCatalog(),
      now: options.now,
      tickMs: 5,
      log: () => undefined,
    });

    try {
      scheduler.start();
      await run({ store, turns, scheduler, close: () => scheduler.close() });
    } finally {
      scheduler.close();
      compaction.close();
      store.close();
    }
  });
}

/** すぐに走るように nextRunAt を過去へ置いたルーチンを作る。 */
function dueRoutine(store: Store, name: string, at: number): string {
  const created = store.createRoutine({
    teraId: "default",
    name,
    prompt: `${name} の指示`,
    schedule: { kind: "every", minutes: 5 },
    enabled: true,
  });
  if (created === null) throw new Error("ルーチンを作れませんでした");
  store.updateRoutine(created.id, { nextRunAt: at });
  return created.id;
}

function userMessages(store: Store) {
  return store.listMessagesSince("default", 0).filter((message) => message.role === "user");
}

const userInput = { content: "利用者の発言", attachments: null, language: "ja" } as const;

describe("ルーチンの順番待ち", () => {
  test("利用者のターンが走っている間に時刻が来ても、終わってから走る", async () => {
    const start = new Date(2024, 0, 1, 9, 0, 0, 0).getTime();
    let current = start;
    const engine = gatedEngine();

    await withScheduler(
      { settings: TEST_SETTINGS, now: () => current, engine },
      async ({ store, turns, scheduler, close }) => {
        try {
          const id = dueRoutine(store, "待つルーチン", start + 60_000);

          // 利用者のターンを始め、モデルの応答を待たせる。
          const user = turns.begin("default", userInput);
          if (user === null) throw new Error("利用者のターンを始められませんでした");
          const userDone = collect(user);
          await engine.started;
          expect(turns.isRunning("default")).toBe(true);

          // 利用者のターンが走っている間に、ルーチンの時刻が来る。
          current = start + 60_000;
          await waitFor(() => scheduler.isRunning(id));

          // 順番待ちの間は、ルーチンの発言を保存しない。
          expect(userMessages(store).map((message) => message.content)).toEqual(["利用者の発言"]);

          engine.release();
          await userDone;

          await waitFor(() => store.readRoutine(id)?.lastStatus === "ok", 5_000);
          const saved = userMessages(store);
          expect(saved.map((message) => message.content)).toEqual(["利用者の発言", "待つルーチン の指示"]);
          // ルーチンが保存した発言には、ルーチンの名前が残る。
          expect(saved[1]?.origin).toBe("待つルーチン");
        } finally {
          close();
        }
      },
    );
  }, 10_000);

  test("同じ時刻に 2 件あっても、1 本ずつ順番に両方走る", async () => {
    const now = new Date(2024, 0, 1, 9, 0, 0, 0).getTime();

    await withScheduler({ settings: TEST_SETTINGS, now: () => now }, async ({ store, close }) => {
      try {
        const first = dueRoutine(store, "1 件目", now);
        const second = dueRoutine(store, "2 件目", now);

        await waitFor(
          () => store.readRoutine(first)?.lastStatus === "ok" && store.readRoutine(second)?.lastStatus === "ok",
          5_000,
        );

        const users = userMessages(store);
        expect(users.map((message) => message.content).sort()).toEqual(["1 件目 の指示", "2 件目 の指示"]);
      } finally {
        close();
      }
    });
  }, 10_000);

  test("順番待ちのうちに止めると、走らずに stopped になる", async () => {
    const start = new Date(2024, 0, 1, 9, 0, 0, 0).getTime();
    let current = start;
    const engine = gatedEngine();

    await withScheduler(
      { settings: TEST_SETTINGS, now: () => current, engine },
      async ({ store, turns, scheduler, close }) => {
        try {
          const id = dueRoutine(store, "待って止める", start + 60_000);

          const user = turns.begin("default", userInput);
          if (user === null) throw new Error("利用者のターンを始められませんでした");
          const userDone = collect(user);
          await engine.started;

          current = start + 60_000;
          await waitFor(() => scheduler.isRunning(id));

          scheduler.stop(id);
          engine.release();
          await userDone;

          await waitFor(() => store.readRoutine(id)?.lastStatus === "stopped", 5_000);
          expect(store.readRoutine(id)?.lastDetail).toBeNull();
          expect(userMessages(store).map((message) => message.content)).toEqual(["利用者の発言"]);
          expect(scheduler.isRunning(id)).toBe(false);
        } finally {
          close();
        }
      },
    );
  }, 10_000);

  test("走っている間に止めると stopped になる", async () => {
    const now = new Date(2024, 0, 1, 9, 0, 0, 0).getTime();
    const engine = gatedEngine();

    await withScheduler({ settings: TEST_SETTINGS, now: () => now, engine }, async ({ store, scheduler, close }) => {
      try {
        const id = dueRoutine(store, "走って止める", now);
        await engine.started;
        await waitFor(() => scheduler.isRunning(id));

        scheduler.stop(id);
        await waitFor(() => store.readRoutine(id)?.lastStatus === "stopped");
        expect(store.readRoutine(id)?.lastDetail).toBeNull();
        expect(scheduler.isRunning(id)).toBe(false);
      } finally {
        close();
      }
    });
  }, 10_000);
});

import { describe, expect, test } from "bun:test";
import { createConversationBroadcast } from "../src/server/agent/broadcast";
import type { AgentEngine } from "../src/server/agent/engine";
import { createMockEngine } from "../src/server/agent/engine/mock";
import { createTurns } from "../src/server/agent/turns";
import { createStore, type Store } from "../src/server/data/store";
import type { FileSettings } from "../src/server/data/settings";
import { parseCatalog, type Catalog } from "../src/server/provider/catalog";
import { createRoutineScheduler, type RoutineScheduler } from "../src/server/routine/scheduler";
import { nextRunAt } from "../src/server/routine/schedule";
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

type Harness = { store: Store; scheduler: RoutineScheduler };

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
      await run({ store, scheduler, close: () => scheduler.close() });
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

describe("ルーチンのスケジューラ", () => {
  test("時刻が来たルーチンが 1 回走り、次回時刻が進む", async () => {
    const now = new Date(2024, 0, 1, 9, 0, 0, 0).getTime();

    await withScheduler({ settings: TEST_SETTINGS, now: () => now }, async ({ store, close }) => {
      try {
        const id = dueRoutine(store, "朝の確認", now);
        await waitFor(() => store.readRoutine(id)?.lastStatus === "ok");

        const read = store.readRoutine(id);
        expect(read?.lastRunAt).toBe(now);
        expect(read?.nextRunAt).toBe(nextRunAt({ kind: "every", minutes: 5 }, now));

        // 指示と応答が 1 組だけ増える。
        const messages = store.listMessagesSince("default", 0);
        expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
        expect(messages.filter((message) => message.role === "user")[0]?.content).toBe("朝の確認 の指示");
        expect(messages.some((message) => message.role === "assistant")).toBe(true);
      } finally {
        close();
      }
    });
  });

  test("モデル未設定なら error で、メッセージは増えない", async () => {
    const now = new Date(2024, 0, 1, 9, 0, 0, 0).getTime();

    await withScheduler({ settings: {}, now: () => now }, async ({ store, close }) => {
      try {
        const id = dueRoutine(store, "設定なし", now);
        await waitFor(() => store.readRoutine(id)?.lastStatus === "error");

        const read = store.readRoutine(id);
        expect(read?.lastDetail).toBe("モデルが設定されていません");
        expect(store.listMessagesSince("default", 0)).toEqual([]);
      } finally {
        close();
      }
    });
  });

  test("stop で stopped になる", async () => {
    const now = new Date(2024, 0, 1, 9, 0, 0, 0).getTime();
    // 止める間があるよう、少しずつ流す。
    const engine = createMockEngine({ chunkSize: 1, delayMs: 50 });

    await withScheduler({ settings: TEST_SETTINGS, now: () => now, engine }, async ({ store, scheduler, close }) => {
      try {
        const id = dueRoutine(store, "止める", now);
        await waitFor(() => scheduler.isRunning(id));

        scheduler.stop(id);
        await waitFor(() => store.readRoutine(id)?.lastStatus === "stopped");

        expect(store.readRoutine(id)?.lastDetail).toBeNull();
        expect(scheduler.isRunning(id)).toBe(false);
      } finally {
        close();
      }
    });
  });

  test("同じ時刻に 2 件あっても、両方走る", async () => {
    const now = new Date(2024, 0, 1, 9, 0, 0, 0).getTime();

    await withScheduler({ settings: TEST_SETTINGS, now: () => now }, async ({ store, close }) => {
      try {
        const first = dueRoutine(store, "1 件目", now);
        const second = dueRoutine(store, "2 件目", now);

        // 1 本ずつ順番に走るので、2 件目は 1 件目が終わってから始まる。
        await waitFor(
          () => store.readRoutine(first)?.lastStatus === "ok" && store.readRoutine(second)?.lastStatus === "ok",
          5_000,
        );

        const users = store.listMessagesSince("default", 0).filter((message) => message.role === "user");
        expect(users.map((message) => message.content).sort()).toEqual(["1 件目 の指示", "2 件目 の指示"]);
      } finally {
        close();
      }
    });
  });
});

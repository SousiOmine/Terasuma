import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import type { RoutineScheduler } from "../src/server/routine/scheduler";
import { createRoutineToolset } from "../src/server/routine/tools";
import type { RoutineStore } from "../src/server/data/store";
import { createRoutineSchedulerStub, makeStore } from "./support";

/**
 * ルーチンのツール。
 * どのツールも、そのターンの Tera のルーチンだけを扱う（他の Tera の id は失敗する）。
 */

/** ツールの実行関数を取り出す。 */
function definitionOf(tools: ToolSet, name: string): { execute: (value: never, options: never) => Promise<unknown> } {
  const definition = tools[name] as { execute?: (value: never, options: never) => unknown } | undefined;
  if (definition?.execute === undefined) throw new Error(`${name} ツールが無い`);
  const execute = definition.execute;
  return { execute: async (value, options) => execute(value, options) };
}

function toolsFor(store: RoutineStore, scheduler: RoutineScheduler, teraId = "default"): ToolSet {
  return createRoutineToolset({ store, routines: scheduler }).toolset({ teraId });
}

const OPTIONS = { toolCallId: "call-1", messages: [] } as never;

const MORNING = {
  name: "朝の確認",
  prompt: "今日の予定を確認して、結果を discord_send で送る",
  schedule: { kind: "daily", time: "08:30" },
} as const;

/** 一定時間たってから終わる runNow（待たずに返ることを確かめるため）。 */
function slowScheduler(): { scheduler: RoutineScheduler; finished: () => boolean } {
  let finished = false;
  const scheduler: RoutineScheduler = {
    start: () => undefined,
    close: () => undefined,
    runNow: () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          finished = true;
          resolve();
        }, 50);
      }),
    isRunning: () => false,
    stop: () => undefined,
  };
  return { scheduler, finished: () => finished };
}

describe("routine_create", () => {
  test("ルーチンを作り、次回時刻を入れて一覧へ載せる", async () => {
    const store = makeStore();
    const scheduler = createRoutineSchedulerStub();
    const create = definitionOf(toolsFor(store, scheduler), "routine_create");

    const output = await create.execute(MORNING as never, OPTIONS);

    const created = store.listRoutinesOf("default")[0];
    expect(created).toBeDefined();
    if (created === undefined) throw new Error("ルーチンが作られていない");

    expect(created.name).toBe(MORNING.name);
    expect(created.prompt).toBe(MORNING.prompt);
    expect(created.enabled).toBe(true);
    expect(created.nextRunAt).not.toBeNull();
    expect(String(output)).toContain(created.id);
    expect(String(output)).toContain(MORNING.name);
    expect(String(output)).toContain("Settings > Tera");
  });

  test("同じ名前は作れない", async () => {
    const store = makeStore();
    const create = definitionOf(toolsFor(store, createRoutineSchedulerStub()), "routine_create");

    await create.execute(MORNING as never, OPTIONS);
    await expect(create.execute(MORNING as never, OPTIONS)).rejects.toThrow("already exists");
  });

  test("50 件を超えては作れない", async () => {
    const store = makeStore();
    for (let index = 0; index < 50; index += 1) {
      store.createRoutine({
        teraId: "default",
        name: `ルーチン ${index}`,
        prompt: "本文",
        schedule: { kind: "every", minutes: 30 },
        enabled: true,
      });
    }
    const create = definitionOf(toolsFor(store, createRoutineSchedulerStub()), "routine_create");

    await expect(create.execute(MORNING as never, OPTIONS)).rejects.toThrow("maximum");
    expect(store.listRoutinesOf("default")).toHaveLength(50);
  });

  test("受け付けられない時刻は作らない", async () => {
    const store = makeStore();
    const create = definitionOf(toolsFor(store, createRoutineSchedulerStub()), "routine_create");

    await expect(
      create.execute({ ...MORNING, schedule: { kind: "daily", time: "99:99" } } as never, OPTIONS),
    ).rejects.toThrow("schedule cannot be used");
    expect(store.listRoutinesOf("default")).toHaveLength(0);
  });
});

describe("routine_list", () => {
  test("作ったルーチンを、id と次回時刻つきで返す", async () => {
    const store = makeStore();
    const tools = toolsFor(store, createRoutineSchedulerStub());
    const create = definitionOf(tools, "routine_create");
    await create.execute(MORNING as never, OPTIONS);

    const output = String(await definitionOf(tools, "routine_list").execute({} as never, OPTIONS));
    const created = store.listRoutinesOf("default")[0];
    if (created === undefined) throw new Error("ルーチンが作られていない");

    expect(output).toContain(created.id);
    expect(output).toContain(MORNING.name);
    expect(output).toContain("daily at 08:30");
    expect(output).toContain("enabled");
  });

  test("0 件なら作り方を返す", async () => {
    const output = String(
      await definitionOf(toolsFor(makeStore(), createRoutineSchedulerStub()), "routine_list").execute(
        {} as never,
        OPTIONS,
      ),
    );

    expect(output).toContain("No routines yet");
    expect(output).toContain("routine_create");
  });
});

describe("routine_update", () => {
  test("enabled を false にすると次回時刻が消える", async () => {
    const store = makeStore();
    const tools = toolsFor(store, createRoutineSchedulerStub());
    await definitionOf(tools, "routine_create").execute(MORNING as never, OPTIONS);
    const created = store.listRoutinesOf("default")[0];
    if (created === undefined) throw new Error("ルーチンが作られていない");

    await definitionOf(tools, "routine_update").execute({ id: created.id, enabled: false } as never, OPTIONS);

    expect(store.readRoutine(created.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  test("スケジュールを変えると次回時刻を計算し直す", async () => {
    const store = makeStore();
    const tools = toolsFor(store, createRoutineSchedulerStub());
    await definitionOf(tools, "routine_create").execute(MORNING as never, OPTIONS);
    const created = store.listRoutinesOf("default")[0];
    if (created === undefined) throw new Error("ルーチンが作られていない");

    await definitionOf(tools, "routine_update").execute(
      { id: created.id, schedule: { kind: "every", minutes: 15 } } as never,
      OPTIONS,
    );

    expect(store.readRoutine(created.id)).toMatchObject({
      schedule: { kind: "every", minutes: 15 },
      enabled: true,
    });
    expect(store.readRoutine(created.id)?.nextRunAt).not.toBeNull();
  });
});

describe("routine_delete", () => {
  test("ルーチンを消す", async () => {
    const store = makeStore();
    const tools = toolsFor(store, createRoutineSchedulerStub());
    await definitionOf(tools, "routine_create").execute(MORNING as never, OPTIONS);
    const created = store.listRoutinesOf("default")[0];
    if (created === undefined) throw new Error("ルーチンが作られていない");

    const output = String(await definitionOf(tools, "routine_delete").execute({ id: created.id } as never, OPTIONS));

    expect(output).toContain("Deleted routine");
    expect(store.readRoutine(created.id)).toBeNull();
  });
});

describe("他の Tera のルーチン", () => {
  test("更新・削除・実行はできない", async () => {
    const store = makeStore();
    store.ensureTera("second", "2 体目");
    const other = store.createRoutine({
      teraId: "second",
      name: "他の Tera のルーチン",
      prompt: "本文",
      schedule: { kind: "every", minutes: 30 },
      enabled: true,
    });
    if (other === null) throw new Error("ルーチンを作れませんでした");

    const scheduler = createRoutineSchedulerStub();
    const tools = toolsFor(store, scheduler, "default");

    await expect(
      definitionOf(tools, "routine_update").execute({ id: other.id, enabled: false } as never, OPTIONS),
    ).rejects.toThrow("not one of this Tera");
    await expect(definitionOf(tools, "routine_delete").execute({ id: other.id } as never, OPTIONS)).rejects.toThrow(
      "not one of this Tera",
    );
    await expect(definitionOf(tools, "routine_run").execute({ id: other.id } as never, OPTIONS)).rejects.toThrow(
      "not one of this Tera",
    );

    expect(store.readRoutine(other.id)).not.toBeNull();
    expect(scheduler.calls).toEqual([]);
  });
});

describe("routine_run", () => {
  test("開始だけして、走り終わるのは待たない", async () => {
    const store = makeStore();
    const { scheduler, finished } = slowScheduler();
    const tools = toolsFor(store, scheduler);
    await definitionOf(tools, "routine_create").execute(MORNING as never, OPTIONS);
    const created = store.listRoutinesOf("default")[0];
    if (created === undefined) throw new Error("ルーチンが作られていない");

    const output = String(await definitionOf(tools, "routine_run").execute({ id: created.id } as never, OPTIONS));

    expect(output).toContain("Started routine");
    expect(finished()).toBe(false);

    // 走り終わるのを待たないので、実行中の印はここではまだ付かない。
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(finished()).toBe(true);
  });
});

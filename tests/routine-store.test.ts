import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/server/data/store";
import { nextRunAt } from "../src/server/routine/schedule";
import { makeStore } from "./support";

const DAILY = { kind: "daily", time: "09:00" } as const;

describe("ルーチンの保存", () => {
  test("作成すると、作成順に並び、有効なら次回時刻を持つ", () => {
    const store = makeStore();

    const first = store.createRoutine({
      teraId: "default",
      name: "朝の確認",
      prompt: "今日の予定を確認して",
      schedule: DAILY,
      enabled: true,
    });
    const second = store.createRoutine({
      teraId: "default",
      name: "夜のまとめ",
      prompt: "今日をまとめて",
      schedule: { kind: "every", minutes: 30 },
      enabled: false,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) throw new Error("ルーチンを作れませんでした");

    expect(first.nextRunAt).toBe(nextRunAt(DAILY, first.createdAt));
    expect(second.nextRunAt).toBeNull();
    expect(store.listRoutinesOf("default").map((routine) => routine.name)).toEqual(["朝の確認", "夜のまとめ"]);
    expect(store.readRoutine(first.id)?.prompt).toBe("今日の予定を確認して");
  });

  test("同じ Tera で同じ名前は作らない", () => {
    const store = makeStore();
    const input = { teraId: "default", name: "同じ名前", prompt: "本文", schedule: DAILY, enabled: true };

    expect(store.createRoutine(input)).not.toBeNull();
    expect(store.createRoutine(input)).toBeNull();

    // 別の Tera なら同じ名前でもよい。
    store.ensureTera("second", "2 体目");
    expect(store.createRoutine({ ...input, teraId: "second" })).not.toBeNull();
  });

  test("更新は渡した項目だけを変える", () => {
    const store = makeStore();
    const created = store.createRoutine({
      teraId: "default",
      name: "元の名前",
      prompt: "元の本文",
      schedule: DAILY,
      enabled: true,
    });
    if (created === null) throw new Error("ルーチンを作れませんでした");

    const at = created.createdAt + 1_000;
    const updated = store.updateRoutine(created.id, { name: "新しい名前", nextRunAt: at });
    if (updated === null) throw new Error("更新できませんでした");

    expect(updated.name).toBe("新しい名前");
    expect(updated.prompt).toBe("元の本文");
    expect(updated.schedule).toEqual(DAILY);
    expect(updated.enabled).toBe(true);
    expect(updated.nextRunAt).toBe(at);

    // nextRunAt: null は「消す」。
    expect(store.updateRoutine(created.id, { nextRunAt: null })?.nextRunAt).toBeNull();
    expect(store.updateRoutine("missing", { name: "x" })).toBeNull();
  });

  test("削除でき、Tera を消すと連鎖で消える", () => {
    const store = makeStore();
    store.ensureTera("second", "2 体目");

    const removable = store.createRoutine({
      teraId: "default",
      name: "消す",
      prompt: "本文",
      schedule: DAILY,
      enabled: true,
    });
    const cascaded = store.createRoutine({
      teraId: "second",
      name: "連鎖で消える",
      prompt: "本文",
      schedule: DAILY,
      enabled: true,
    });
    if (removable === null || cascaded === null) throw new Error("ルーチンを作れませんでした");

    expect(store.deleteRoutine(removable.id)).toBe(true);
    expect(store.deleteRoutine(removable.id)).toBe(false);
    expect(store.readRoutine(removable.id)).toBeNull();

    expect(store.deleteTera("second")).toBe(true);
    expect(store.listRoutinesOf("second")).toEqual([]);
  });

  test("dueRoutines は有効かつ時刻が来たものだけを返す", () => {
    const store = makeStore();

    const due = store.createRoutine({
      teraId: "default",
      name: "時刻が来た",
      prompt: "本文",
      schedule: DAILY,
      enabled: true,
    });
    const disabled = store.createRoutine({
      teraId: "default",
      name: "無効",
      prompt: "本文",
      schedule: DAILY,
      enabled: false,
    });
    const future = store.createRoutine({
      teraId: "default",
      name: "まだ先",
      prompt: "本文",
      schedule: DAILY,
      enabled: true,
    });
    if (due === null || disabled === null || future === null) throw new Error("ルーチンを作れませんでした");

    store.updateRoutine(due.id, { nextRunAt: 100 });
    store.updateRoutine(disabled.id, { nextRunAt: 100 });
    store.updateRoutine(future.id, { nextRunAt: 1_000 });

    expect(store.dueRoutines(100).map((routine) => routine.id)).toEqual([due.id]);
    expect(store.dueRoutines(999).map((routine) => routine.id)).toEqual([due.id]);
    expect(store.dueRoutines(1_000).map((routine) => routine.id)).toEqual([due.id, future.id]);
  });

  test("recordRoutineRun は結果と次回時刻を書く", () => {
    const store = makeStore();
    const created = store.createRoutine({
      teraId: "default",
      name: "結果",
      prompt: "本文",
      schedule: DAILY,
      enabled: true,
    });
    if (created === null) throw new Error("ルーチンを作れませんでした");

    store.recordRoutineRun(created.id, {
      lastRunAt: 500,
      lastStatus: "error",
      lastDetail: "失敗した",
      nextRunAt: 900,
    });

    const read = store.readRoutine(created.id);
    expect(read?.lastRunAt).toBe(500);
    expect(read?.lastStatus).toBe("error");
    expect(read?.lastDetail).toBe("失敗した");
    expect(read?.nextRunAt).toBe(900);

    store.recordRoutineRun(created.id, {
      lastRunAt: 600,
      lastStatus: "ok",
      lastDetail: null,
      nextRunAt: 900,
    });
    expect(store.readRoutine(created.id)?.nextRunAt).toBe(900);
  });

  test("壊れたスケジュールの行は、無効として読む", () => {
    const path = join(tmpdir(), `terasuma-routine-${crypto.randomUUID()}.db`);

    try {
      const first = createStore(path);
      const created = first.createRoutine({
        teraId: "default",
        name: "壊れた",
        prompt: "本文",
        schedule: DAILY,
        enabled: true,
      });
      if (created === null) throw new Error("ルーチンを作れませんでした");
      first.close();

      // 保存層の外から壊す（1 行が壊れても一覧が落ちないことを確かめる）。
      const db = new Database(path);
      db.query<unknown, [string, string]>("UPDATE routines SET schedule = ? WHERE id = ?").run("not json", created.id);
      db.close();

      const second = createStore(path);
      try {
        const read = second.readRoutine(created.id);
        expect(read?.enabled).toBe(false);
        expect(read?.nextRunAt).toBeNull();
        expect(read?.lastDetail).toBe("保存されたスケジュールを読めません");
        expect(second.listRoutinesOf("default")).toHaveLength(1);
      } finally {
        second.close();
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});

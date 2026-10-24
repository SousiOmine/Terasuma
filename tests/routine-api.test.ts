import { describe, expect, test } from "bun:test";
import type { RoutineView } from "../src/shared/api/routine";
import type { RoutineRecord } from "../src/server/data/store";
import type { RoutineScheduler } from "../src/server/routine/scheduler";
import { type ServerHarness, withServer } from "./harness";
import { createRoutineSchedulerStub } from "./support";

/**
 * ルーチンの HTTP API。
 * スケジューラは差し替え、開始・停止の呼び出しだけを確かめる（実際には走らせない）。
 */

type Run = (
  harness: ServerHarness,
  scheduler: RoutineScheduler & { calls: string[]; running: Set<string> },
) => Promise<void>;

async function withRoutineServer(run: Run): Promise<void> {
  const scheduler = createRoutineSchedulerStub();
  await withServer((harness) => run(harness, scheduler), { routines: scheduler });
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** ルーチンを 1 つ作る。 */
function createRoutine(harness: ServerHarness, options: { teraId?: string; name?: string } = {}): RoutineRecord {
  const created = harness.store.createRoutine({
    teraId: options.teraId ?? "default",
    name: options.name ?? "朝の確認",
    prompt: "今日の予定を確認して",
    schedule: { kind: "daily", time: "08:30" },
    enabled: true,
  });
  if (created === null) throw new Error("ルーチンを作れませんでした");
  return created;
}

async function routines(harness: ServerHarness): Promise<RoutineView[]> {
  const response = await harness.request("/api/routines");
  expect(response.status).toBe(200);
  return ((await response.json()) as { routines: RoutineView[] }).routines;
}

describe("ルーチンの API", () => {
  test("一覧は Tera の名前と実行中の印を返す", async () => {
    await withRoutineServer(async (harness, scheduler) => {
      harness.store.ensureTera("second", "2 体目");
      const first = createRoutine(harness);
      const second = createRoutine(harness, { teraId: "second", name: "夜のまとめ" });
      scheduler.running.add(second.id);

      const view = await routines(harness);
      const byId = new Map(view.map((routine) => [routine.id, routine]));

      expect(view).toHaveLength(2);
      expect(byId.get(first.id)).toMatchObject({
        teraId: "default",
        teraName: "Tera",
        name: "朝の確認",
        enabled: true,
        running: false,
      });
      expect(byId.get(second.id)).toMatchObject({
        teraId: "second",
        teraName: "2 体目",
        running: true,
      });
    });
  });

  test("PATCH で有効/無効を切り替える。enabled 以外は受け付けない", async () => {
    await withRoutineServer(async (harness) => {
      const created = createRoutine(harness);

      const disabled = await harness.request(`/api/routines/${created.id}`, jsonRequest("PATCH", { enabled: false }));
      expect(disabled.status).toBe(200);
      expect(harness.store.readRoutine(created.id)).toMatchObject({ enabled: false, nextRunAt: null });

      const enabled = await harness.request(`/api/routines/${created.id}`, jsonRequest("PATCH", { enabled: true }));
      expect(enabled.status).toBe(200);
      expect(harness.store.readRoutine(created.id)?.nextRunAt).not.toBeNull();

      // enabled が無い本文は、ほかの項目があっても 400（名前も変えない）。
      const other = await harness.request(`/api/routines/${created.id}`, jsonRequest("PATCH", { name: "変えた名前" }));
      expect(other.status).toBe(400);
      expect(((await other.json()) as { code: string }).code).toBe("invalid_request");
      expect(harness.store.readRoutine(created.id)?.name).toBe("朝の確認");

      const wrongType = await harness.request(
        `/api/routines/${created.id}`,
        jsonRequest("PATCH", { enabled: "false" }),
      );
      expect(wrongType.status).toBe(400);
    });
  });

  test("DELETE で消える", async () => {
    await withRoutineServer(async (harness) => {
      const created = createRoutine(harness);

      const response = await harness.request(`/api/routines/${created.id}`, { method: "DELETE" });

      expect(response.status).toBe(200);
      expect(harness.store.readRoutine(created.id)).toBeNull();
      expect(await routines(harness)).toEqual([]);
    });
  });

  test("いま実行と停止はスケジューラを呼び、一覧を返す", async () => {
    await withRoutineServer(async (harness, scheduler) => {
      const created = createRoutine(harness);

      const started = await harness.request(`/api/routines/${created.id}/run`, { method: "POST" });
      expect(started.status).toBe(200);
      expect(((await started.json()) as { routines: RoutineView[] }).routines[0]?.running).toBe(true);

      const stopped = await harness.request(`/api/routines/${created.id}/stop`, { method: "POST" });
      expect(stopped.status).toBe(200);
      expect(((await stopped.json()) as { routines: RoutineView[] }).routines[0]?.running).toBe(false);

      expect(scheduler.calls).toEqual([`run:${created.id}`, `stop:${created.id}`]);
    });
  });

  test("無い id は 404", async () => {
    await withRoutineServer(async (harness) => {
      for (const [path, init] of [
        ["/api/routines/missing", jsonRequest("PATCH", { enabled: false })],
        ["/api/routines/missing", { method: "DELETE" }],
        ["/api/routines/missing/run", { method: "POST" }],
        ["/api/routines/missing/stop", { method: "POST" }],
      ] as const) {
        const response = await harness.request(path, init);
        expect(response.status).toBe(404);
        expect(((await response.json()) as { code: string }).code).toBe("not_found");
      }
    });
  });
});

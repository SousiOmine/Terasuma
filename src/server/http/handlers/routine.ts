import type { RoutineView } from "../../../shared/api/routine";
import { AppError } from "../../errors";
import { readRoutineToggleForm } from "../body";
import { json } from "../respond";
import { nextRunAt } from "../../routine/schedule";
import type { RoutineRecord } from "../../data/store";
import type { ApiDeps, ApiRequest } from "./shared";

/**
 * スケジュールされた実行（ルーチン）の設定。
 *
 * 一覧は Tera の並び順、その中は作成順で返す（画面のサイドバーと同じ順になる）。
 * 変えられるのは有効/無効だけで、名前・指示・スケジュールはチャットのツールから変える。
 * 「いま実行」は走り終わるのを待たず、開始した時点で一覧を返す。
 */
export function routineHandlers(deps: Pick<ApiDeps, "store" | "routines">) {
  const { store, routines } = deps;

  /** 無い id は 404。 */
  function requireRoutine(id: string): RoutineRecord {
    const routine = store.readRoutine(id);
    if (routine === null) throw new AppError("not_found", `ルーチン ${id} はありません`);
    return routine;
  }

  /** 一覧を作る。teraName は Tera の一覧から引き、無ければ id をそのまま使う。 */
  function routinesView(): RoutineView[] {
    const names = new Map(store.listTeras().map((tera) => [tera.id, tera.name]));

    return store.listRoutines().map((routine) => ({
      id: routine.id,
      teraId: routine.teraId,
      teraName: names.get(routine.teraId) ?? routine.teraId,
      name: routine.name,
      prompt: routine.prompt,
      schedule: routine.schedule,
      enabled: routine.enabled,
      nextRunAt: routine.nextRunAt,
      lastRunAt: routine.lastRunAt,
      lastStatus: routine.lastStatus,
      lastDetail: routine.lastDetail,
      running: routines.isRunning(routine.id),
    }));
  }

  return {
    /** すべてのルーチン。 */
    readRoutines(): Response {
      return json({ routines: routinesView() });
    },

    /** 有効/無効を切り替える。無効にすると次回時刻を消し、有効にすると今から計算し直す。 */
    async updateRoutine(req: ApiRequest<{ id: string }>): Promise<Response> {
      const routine = requireRoutine(req.params.id);
      const form = await readRoutineToggleForm(req);
      store.updateRoutine(routine.id, {
        enabled: form.enabled,
        nextRunAt: form.enabled ? nextRunAt(routine.schedule, Date.now()) : null,
      });

      return json({ routines: routinesView() });
    },

    /** ルーチンを消す（取り消せない）。 */
    deleteRoutine(req: ApiRequest<{ id: string }>): Response {
      requireRoutine(req.params.id);
      store.deleteRoutine(req.params.id);
      return json({ routines: routinesView() });
    },

    /** いま実行する。走り終わるのは待たない（結果は会話へ流れる）。 */
    runRoutine(req: ApiRequest<{ id: string }>): Response {
      requireRoutine(req.params.id);
      void routines.runNow(req.params.id);
      return json({ routines: routinesView() });
    },

    /** 走っているルーチンを止める。 */
    stopRoutine(req: ApiRequest<{ id: string }>): Response {
      requireRoutine(req.params.id);
      routines.stop(req.params.id);
      return json({ routines: routinesView() });
    },
  };
}

import { tool } from "ai";
import { z } from "zod";
import {
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
  ROUTINE_NAME_MAX_CHARS,
  ROUTINE_PROMPT_MAX_CHARS,
  ROUTINES_PER_TERA_MAX,
  type RoutineSchedule,
} from "../../shared/api/routine";
import { formatLocalDate } from "../../shared/text";
import {
  ROUTINE_CREATE_TOOL_NAME,
  ROUTINE_DELETE_TOOL_NAME,
  ROUTINE_LIST_TOOL_NAME,
  ROUTINE_RUN_TOOL_NAME,
  ROUTINE_UPDATE_TOOL_NAME,
} from "../../shared/tools";
import type { RoutineRecord, RoutineStore } from "../data/store";
import type { RoutineToolset, RoutineToolsetProvider } from "../agent/contracts";
import { nextRunAt, normalizeSchedule, scheduleProblem } from "./schedule";
import type { RoutineScheduler } from "./scheduler";

/**
 * スケジュールされた実行（ルーチン）の内蔵ツール。
 *
 * ルーチンは「決まった時刻に、保存した指示で自分から走るターン」。
 * どのツールも、そのターンの Tera のルーチンだけを扱う（他の Tera の id は受け付けない）。
 *
 * ツール一覧には載せず、tool_search で見つけて tool_call で実行する。
 * 扱うルーチンはターンの Tera で決まるので、ツール一式はターンごとに組む。
 */

export function createRoutineToolset(options: {
  store: RoutineStore;
  routines: RoutineScheduler;
}): RoutineToolsetProvider {
  return {
    toolset({ teraId }) {
      return createRoutineTools({ store: options.store, routines: options.routines, teraId });
    },
  };
}

/** ルーチンの実行時刻の決め方。画面と API の入力と同じ形にする。 */
const scheduleSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

type CreateInput = {
  name: string;
  prompt: string;
  schedule: unknown;
};

type UpdateInput = {
  id: string;
  name?: string;
  prompt?: string;
  schedule?: unknown;
  enabled?: boolean;
};

type IdInput = { id: string };

/** 受け取ったスケジュールを保存できる形に寄せる。寄せられなければ例つきで断る。 */
function usableSchedule(value: unknown): RoutineSchedule {
  const schedule = normalizeSchedule(value);
  // 寄せられなかったときも、いままでと同じ理由（時刻の形式など）を返す。
  const problem = scheduleProblem(schedule ?? value);
  if (schedule === null || problem !== null) {
    throw new Error(
      `The schedule cannot be used (${problem ?? "the value is not a schedule"}); ` +
        'use {"kind":"daily","time":"08:30"}, {"kind":"weekly","days":[1,5],"time":"18:00"}, or {"kind":"every","minutes":30}.',
    );
  }
  return schedule;
}

function createRoutineTools(options: {
  store: RoutineStore;
  routines: RoutineScheduler;
  teraId: string;
}): RoutineToolset {
  const { store, routines, teraId } = options;

  /** この Tera のルーチンだけを読む。他の Tera の id は、無いものとして扱う。 */
  function ownedRoutine(id: string): RoutineRecord {
    const routine = store.readRoutine(id);
    if (routine === null || routine.teraId !== teraId) {
      throw new Error(
        `Routine ${JSON.stringify(id)} is not one of this Tera's routines; ` +
          "use routine_list to see the routines this Tera has.",
      );
    }
    return routine;
  }

  return {
    [ROUTINE_CREATE_TOOL_NAME]: tool({
      description: [
        "Create a routine: a saved instruction that this Tera runs by itself at a fixed local time or interval.",
        `name is 1-${ROUTINE_NAME_MAX_CHARS} characters; prompt is the instruction sent as the user's message when it runs (1-${ROUTINE_PROMPT_MAX_CHARS} characters).`,
        `schedule is {"kind":"daily","time":"HH:MM"}, {"kind":"weekly","days":[1,3,5],"time":"HH:MM"} (1 = Monday … 7 = Sunday), or {"kind":"every","minutes":30} (${MIN_EVERY_MINUTES}-${MAX_EVERY_MINUTES}).`,
        'Times like "8:30" or "8時30分" are accepted; they are stored as "08:30".',
        `Call this only when the user asked for something to happen on a schedule. A Tera can have at most ${ROUTINES_PER_TERA_MAX} routines.`,
      ].join(" "),
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(ROUTINE_NAME_MAX_CHARS)
          .describe(`Short name shown in the routine list (1-${ROUTINE_NAME_MAX_CHARS} characters)`),
        prompt: z
          .string()
          .min(1)
          .max(ROUTINE_PROMPT_MAX_CHARS)
          .describe("Instruction sent as the user's message when the routine runs"),
        schedule: scheduleSchema.describe("When to run it, in local time"),
      }),
      execute: async ({ name, prompt, schedule }: CreateInput) => {
        const displayName = name.trim();
        if (displayName.length === 0) {
          throw new Error(`The name must not be empty; write 1-${ROUTINE_NAME_MAX_CHARS} characters.`);
        }

        const normalized = usableSchedule(schedule);

        const current = store.listRoutinesOf(teraId);
        if (current.length >= ROUTINES_PER_TERA_MAX) {
          throw new Error(
            `This Tera already has ${ROUTINES_PER_TERA_MAX} routines, the maximum; ` +
              "delete one with routine_delete before creating another.",
          );
        }
        if (current.some((routine) => routine.name === displayName)) {
          throw new Error(
            `A routine named ${JSON.stringify(displayName)} already exists for this Tera; ` +
              "choose another name, or change that one with routine_update.",
          );
        }

        const created = store.createRoutine({ teraId, name: displayName, prompt, schedule: normalized, enabled: true });
        if (created === null) {
          throw new Error(
            `A routine named ${JSON.stringify(displayName)} already exists for this Tera; choose another name.`,
          );
        }

        // 作った時点から次に走る時刻を持たせる（作ったのに走らない、を防ぐ）。
        const next = nextRunAt(normalized, Date.now());
        store.updateRoutine(created.id, { nextRunAt: next });

        return [
          `Created routine ${JSON.stringify(created.name)} (id ${JSON.stringify(created.id)}).`,
          `Schedule: ${scheduleText(normalized)} (local time).`,
          `Next run: ${formatLocalTime(next)} (local time).`,
          "You can disable, delete, or run it now from Settings > Tera, or by right-clicking the Tera in the sidebar.",
        ].join("\n");
      },
    }),

    [ROUTINE_LIST_TOOL_NAME]: tool({
      description: [
        "List this Tera's routines with id, name, schedule, whether it is enabled, the next run, and the last result.",
        "Call this before routine_update, routine_delete or routine_run when you do not have the id.",
      ].join(" "),
      inputSchema: z.object({}),
      execute: async () => {
        const found = store.listRoutinesOf(teraId);
        if (found.length === 0) return "No routines yet. Create one with routine_create.";

        return found
          .map((routine) => {
            const running = routines.isRunning(routine.id) ? "; running now" : "";
            return `- ${routine.name} (id ${routine.id}): ${scheduleText(routine.schedule)}; ${
              routine.enabled ? "enabled" : "disabled"
            }; next ${nextText(routine)}; last ${lastRunText(routine)}${running}`;
          })
          .join("\n");
      },
    }),

    [ROUTINE_UPDATE_TOOL_NAME]: tool({
      description: [
        "Change one of this Tera's routines; pass id and only the fields to change: name, prompt, schedule, enabled.",
        "Changing the schedule recomputes the next run. Setting enabled to false clears the next run; setting it to true schedules it again from now.",
        'Times like "8:30" or "8時30分" are accepted; they are stored as "08:30".',
        "Use routine_list first when you do not have the id.",
      ].join(" "),
      inputSchema: z.object({
        id: z.string().min(1).describe("Routine id from routine_list"),
        name: z
          .string()
          .min(1)
          .max(ROUTINE_NAME_MAX_CHARS)
          .optional()
          .describe(`New name (1-${ROUTINE_NAME_MAX_CHARS} characters)`),
        prompt: z
          .string()
          .min(1)
          .max(ROUTINE_PROMPT_MAX_CHARS)
          .optional()
          .describe("New instruction sent when the routine runs"),
        schedule: scheduleSchema.optional().describe("New schedule, in local time"),
        enabled: z.boolean().optional().describe("false stops future runs; true starts them again"),
      }),
      execute: async ({ id, name, prompt, schedule, enabled }: UpdateInput) => {
        const current = ownedRoutine(id);

        const displayName = name === undefined ? undefined : name.trim();
        if (displayName !== undefined && displayName.length === 0) {
          throw new Error(`The name must not be empty; write 1-${ROUTINE_NAME_MAX_CHARS} characters.`);
        }
        if (displayName !== undefined) {
          const sameName = store
            .listRoutinesOf(teraId)
            .some((routine) => routine.id !== id && routine.name === displayName);
          if (sameName) {
            throw new Error(
              `A routine named ${JSON.stringify(displayName)} already exists for this Tera; choose another name.`,
            );
          }
        }

        const normalized = schedule === undefined ? undefined : usableSchedule(schedule);

        // 次に走る時刻は、有効/無効とスケジュールの変更に合わせて決め直す。
        const updatedSchedule = normalized ?? current.schedule;
        const updatedEnabled = enabled ?? current.enabled;
        let nextRun: number | null | undefined;
        if (enabled === false) nextRun = null;
        else if (enabled === true) nextRun = nextRunAt(updatedSchedule, Date.now());
        else if (normalized !== undefined) {
          nextRun = current.enabled ? nextRunAt(updatedSchedule, Date.now()) : null;
        }

        const updated = store.updateRoutine(id, {
          ...(displayName === undefined ? {} : { name: displayName }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(normalized === undefined ? {} : { schedule: normalized }),
          ...(enabled === undefined ? {} : { enabled }),
          ...(nextRun === undefined ? {} : { nextRunAt: nextRun }),
        });
        if (updated === null) {
          throw new Error(
            `Routine ${JSON.stringify(id)} no longer exists; use routine_list to see the routines this Tera has.`,
          );
        }

        return [
          `Updated routine ${JSON.stringify(updated.name)} (id ${JSON.stringify(updated.id)}).`,
          updatedEnabled ? `Next run: ${nextText(updated)}.` : "It is disabled, so it will not run.",
        ].join("\n");
      },
    }),

    [ROUTINE_DELETE_TOOL_NAME]: tool({
      description: [
        "Delete one of this Tera's routines permanently.",
        "This cannot be undone, so ask the user to confirm before calling it.",
        "Use routine_list first when you do not have the id.",
      ].join(" "),
      inputSchema: z.object({
        id: z.string().min(1).describe("Routine id from routine_list"),
      }),
      execute: async ({ id }: IdInput) => {
        const routine = ownedRoutine(id);
        if (!store.deleteRoutine(id)) {
          throw new Error(`Routine ${JSON.stringify(id)} no longer exists; nothing was deleted.`);
        }
        return `Deleted routine ${JSON.stringify(routine.name)} (id ${JSON.stringify(id)}).`;
      },
    }),

    [ROUTINE_RUN_TOOL_NAME]: tool({
      description: [
        "Start one of this Tera's routines now and return immediately.",
        "Its result streams into this conversation as its own turn, so do not wait for it here.",
        "Use routine_list first when you do not have the id.",
      ].join(" "),
      inputSchema: z.object({
        id: z.string().min(1).describe("Routine id from routine_list"),
      }),
      execute: async ({ id }: IdInput) => {
        const routine = ownedRoutine(id);
        // ターンを止めてしまわないよう、走り終わるのは待たない。
        void routines.runNow(id);
        return `Started routine ${JSON.stringify(routine.name)} (id ${JSON.stringify(id)}). Its result appears in this conversation when it finishes.`;
      },
    }),
  };
}

/** スケジュールを 1 行の英語にする（一覧の表示に使う）。 */
function scheduleText(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return `daily at ${schedule.time}`;
    case "weekly":
      return `weekly on ${schedule.days.map(weekdayName).join(", ")} at ${schedule.time}`;
    case "every":
      return `every ${schedule.minutes} minutes`;
  }
}

/** 曜日の名前。1 = 月 … 7 = 日。 */
function weekdayName(day: number): string {
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 1] ?? String(day);
}

/** 次に走る時刻。無効なら none。 */
function nextText(routine: RoutineRecord): string {
  if (!routine.enabled) return "none (disabled)";
  if (routine.nextRunAt === null) return "not scheduled";
  return formatLocalTime(routine.nextRunAt);
}

/** 最後の実行の結果。 */
function lastRunText(routine: RoutineRecord): string {
  if (routine.lastStatus === null) return "never run";

  const at = routine.lastRunAt === null ? "" : ` at ${formatLocalTime(routine.lastRunAt)}`;
  if (routine.lastStatus === "error" && routine.lastDetail !== null) {
    return `error${at} (${routine.lastDetail})`;
  }
  return `${routine.lastStatus}${at}`;
}

/** ローカル時刻の "YYYY-MM-DD HH:mm"。 */
function formatLocalTime(at: number): string {
  return formatLocalDate(at, { time: true });
}

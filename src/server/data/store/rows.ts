import { isChatAttachment, isMessagePart } from "../../../shared/chat-event";
import type { ChatAttachment, ChatMessage, MessagePart, MessageRole, Tera } from "../../../shared/api/message";
import type { RoutineSchedule, RoutineStatus } from "../../../shared/api/routine";
import { parseSchedule } from "../../routine/schedule";
import type { RoutineRecord } from "./types";

/** SQLite の行と、ドメインの型の対応。 */

export type TeraRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
};

export type MessageRow = {
  id: string;
  tera_id: string;
  seq: number;
  role: string;
  content: string;
  attachments: string | null;
  parts: string | null;
  origin: string | null;
  created_at: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
};

export type RoutineRow = {
  id: string;
  tera_id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_detail: string | null;
  created_at: number;
  updated_at: number;
};

export function toTera(row: TeraRow): Tera {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** 読めないスケジュールの代わりに持たせる値。無効にしてあるので、この時刻で走ることはない。 */
const UNREADABLE_SCHEDULE: RoutineSchedule = { kind: "daily", time: "00:00" };

export function toRoutine(row: RoutineRow): RoutineRecord {
  const schedule = readSchedule(row.schedule);
  const readable = schedule !== null;

  return {
    id: row.id,
    teraId: row.tera_id,
    name: row.name,
    prompt: row.prompt,
    schedule: schedule ?? UNREADABLE_SCHEDULE,
    // 1 行が壊れても一覧を落とさない。走らせないよう、無効として返す。
    enabled: readable && row.enabled === 1,
    nextRunAt: readable ? row.next_run_at : null,
    lastRunAt: row.last_run_at,
    lastStatus: readStatus(row.last_status),
    lastDetail: readable ? row.last_detail : "保存されたスケジュールを読めません",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMessage(row: MessageRow): ChatMessage {
  const usage =
    row.input_tokens === null && row.output_tokens === null && row.cached_input_tokens === null
      ? null
      : {
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          cachedInputTokens: row.cached_input_tokens ?? 0,
        };

  return {
    id: row.id,
    teraId: row.tera_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: row.content,
    attachments: readAttachments(row),
    parts: readParts(row),
    origin: row.origin ?? null,
    createdAt: row.created_at,
    usage,
  };
}

/** 保存されたスケジュールを読む。壊れていれば null（呼び出し側が無効として扱う）。 */
function readSchedule(raw: string): RoutineSchedule | null {
  try {
    return parseSchedule(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 保存された実行結果を読む。知らない値は無かったことにする。 */
function readStatus(value: string | null): RoutineStatus | null {
  return value === "running" || value === "ok" || value === "error" || value === "stopped" ? value : null;
}

/** 画面に出す添付ファイルを読み戻す。読めない値は黙って捨てず、そのまま失敗させる。 */
function readAttachments(row: MessageRow): ChatAttachment[] | null {
  if (row.attachments === null) return null;

  const parsed: unknown = JSON.parse(row.attachments);
  if (!Array.isArray(parsed) || !parsed.every(isChatAttachment)) {
    throw new Error(`メッセージ ${row.id} の attachments は添付ファイルの配列ではありません`);
  }
  return parsed;
}

/** 保存されている部分を読み戻す。読めない値は黙って捨てず、そのまま失敗させる。 */
function readParts(row: MessageRow): MessagePart[] | null {
  if (row.parts === null) return null;

  const parsed: unknown = JSON.parse(row.parts);
  if (!Array.isArray(parsed) || !parsed.every(isMessagePart)) {
    throw new Error(`メッセージ ${row.id} の parts は部品の配列ではありません`);
  }
  return parsed;
}

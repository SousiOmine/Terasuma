import { rmSync } from "node:fs";
import { readPrivateJson, writePrivateJson } from "../data/secret-file";

/**
 * program コネクタの確認結果を 1 ファイルに保存する。
 *
 * トークンではないが、置き場と権限は token-store.ts と同じにする
 * （ディレクトリ 0700、ファイル 0600、読み出しは覚えておき、save/clear で覚え直す）。
 */

/** 確かめた結果。 */
export type ProgramRecord = {
  /** 確かめた結果の 1 行（例: "pi 1.3.0 (anthropic/claude-sonnet-4-5)"）。 */
  status: string;
  /** 設定されている provider id。分からなければ null。 */
  provider: string | null;
  /** 設定されているモデル。分からなければ null。 */
  model: string | null;
  /** 取得した時刻。epoch ミリ秒。 */
  checkedAt: number;
};

/** 読み出した結果。未確認と、読めなかった理由を区別する。 */
export type ProgramRecordState =
  | { kind: "none" }
  | { kind: "record"; record: ProgramRecord }
  | { kind: "unreadable"; detail: string };

export type ProgramStore = {
  read(): ProgramRecordState;
  save(record: ProgramRecord): void;
  clear(): void;
};

export function createProgramStore(path: string): ProgramStore {
  // 読み出しは接続状態を見るたびに走るので、覚えておく。
  // 書くのはこのプロセスだけなので、保存・削除のときに覚え直せば足りる。
  let cached: ProgramRecordState | null = null;

  function load(): ProgramRecordState {
    if (cached !== null) return cached;

    const content = readPrivateJson(path);
    if (content.kind === "missing") {
      cached = { kind: "none" };
      return cached;
    }
    if (content.kind === "unreadable") {
      cached = { kind: "unreadable", detail: content.detail };
      return cached;
    }
    if (!isProgramRecord(content.value)) {
      cached = { kind: "unreadable", detail: `${path} の内容がプログラムの記録として読めません` };
      return cached;
    }

    cached = {
      kind: "record",
      record: {
        status: content.value.status,
        provider: content.value.provider ?? null,
        model: content.value.model ?? null,
        checkedAt: content.value.checkedAt,
      },
    };
    return cached;
  }

  return {
    read() {
      return load();
    },

    save(record) {
      writePrivateJson(path, record, { createDirectory: true });
      cached = { kind: "record", record };
    },

    clear() {
      rmSync(path, { force: true });
      cached = { kind: "none" };
    },
  };
}

/** 前の版の記録には無い項目なので、無い・null・文字列を受け付ける。 */
function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/** 保存した形として読めるかどうか。壊れた値を記録として使わない。 */
function isProgramRecord(value: unknown): value is ProgramRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  return (
    typeof record["status"] === "string" &&
    record["status"].length > 0 &&
    isOptionalString(record["provider"]) &&
    isOptionalString(record["model"]) &&
    typeof record["checkedAt"] === "number" &&
    Number.isFinite(record["checkedAt"])
  );
}

import { rmSync } from "node:fs";
import { readPrivateJson, writePrivateJson } from "./secret-file";

/**
 * 秘密を含む JSON 1 ファイルを、プロセスの中で覚えながら読み書きするストア。
 *
 * コネクタのトークン、program コネクタの確認結果、Discord の webhook が、
 * どれも「無い・読めた・読めないを区別する」「書くのはこのプロセスだけなので、保存と削除で覚え直す」
 * という同じ形を必要としていた。形を各ファイルに書き写すと、権限や検証の抜けが生まれる。
 *
 * 値の検証は呼び出し側が渡す（保存した形として読めるかを、その型の持ち主が決める）。
 * 読み出しの結果は 3 値で返し、「未設定」と「壊れている」を区別する。
 */

/** 読み出した結果。無い・読めた・壊れているを区別する。 */
export type StoreContent<T> =
  | { kind: "missing" }
  | { kind: "value"; value: T }
  | { kind: "unreadable"; detail: string };

export type PrivateJsonStore<T> = {
  /** 覚えている値を返す。まだ読んでいなければ、ここでファイルを読む。 */
  read(): StoreContent<T>;
  /** 書いて、覚え直す。ディレクトリが無ければ 0700 で作る。 */
  save(value: T): void;
  /** ファイルを消して、未設定として覚え直す。無くても失敗しない。 */
  clear(): void;
};

export type PrivateJsonStoreOptions<T> = {
  /** 保存するファイルの絶対パス。 */
  path: string;
  /** 保存した形として読めるかどうか。読めない値は unreadable として扱う。 */
  is: (value: unknown) => value is T;
  /** 読めなかったときに付ける説明の前置き（例: "コネクタの記録として読めません"）。 */
  what: string;
  /** 一時ファイルを経由して置き換える（途中で落ちても元のファイルを壊さない）。 */
  createDirectory?: boolean;
};

export function createPrivateJsonStore<T>(options: PrivateJsonStoreOptions<T>): PrivateJsonStore<T> {
  const { path, is, what } = options;
  let cached: StoreContent<T> | null = null;

  function load(): StoreContent<T> {
    if (cached !== null) return cached;

    const content = readPrivateJson(path);
    if (content.kind === "missing") {
      cached = { kind: "missing" };
      return cached;
    }
    if (content.kind === "unreadable") {
      cached = { kind: "unreadable", detail: content.detail };
      return cached;
    }
    if (!is(content.value)) {
      cached = { kind: "unreadable", detail: `${path} の内容が${what}` };
      return cached;
    }

    cached = { kind: "value", value: content.value };
    return cached;
  }

  return {
    read() {
      return load();
    },

    save(value) {
      writePrivateJson(path, value, { createDirectory: options.createDirectory ?? true });
      cached = { kind: "value", value };
    },

    clear() {
      rmSync(path, { force: true });
      cached = { kind: "missing" };
    },
  };
}

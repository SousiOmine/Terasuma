import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describeError } from "../../shared/errors";

/**
 * JSON のファイル読み書き。
 *
 * 設定（config.json）、コネクタのトークン、MCP の OAuth の材料、エージェントが送った画像やファイル、
 * models.dev のカタログが、どれも「一時ファイルへ書いてから置き換える」形を必要とする。
 * 途中で落ちても、元のファイルは壊れない。
 *
 * 秘密を含むファイルは権限を絞る（ディレクトリ 0700、ファイル 0600）。画像やカタログのように
 * 秘密でないものは、端末の既定の権限のまま置く（他の利用者に読まれても困らないため）。
 * 権限の付け方を 1 か所にまとめ、片方だけ抜ける状態を作らない。
 */

/** 読み出した結果。無い・読めた・壊れているを区別する。 */
export type PrivateFileContent =
  | { kind: "missing" }
  | { kind: "value"; value: unknown }
  | { kind: "unreadable"; detail: string };

export function readPrivateJson(path: string): PrivateFileContent {
  if (!existsSync(path)) return { kind: "missing" };

  try {
    return { kind: "value", value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { kind: "unreadable", detail: describeError(error) };
  }
}

export type WriteJsonOptions = {
  /**
   * 置き場のディレクトリをこの書き込みが持つ場合だけ付ける（トークンなど）。
   * 設定ファイルは起動時に ensureDirectories が作るので、無いときは失敗させる（黙って作り直さない）。
   */
  createDirectory?: boolean;
  /** 秘密として扱うか。既定は false（端末の既定の権限で置く）。 */
  secret?: boolean;
};

/**
 * 一時ファイルへ書いてから置き換える。途中で落ちても、元のファイルはそのまま残る。
 * 改行を末尾に 1 つ足す（手で開いたときに差分が出にくい形にするため）。
 */
export function writeJson(path: string, value: unknown, options: WriteJsonOptions = {}): void {
  const secret = options.secret === true;

  if (options.createDirectory === true) mkdirSync(dirname(path), { recursive: true, mode: secret ? 0o700 : undefined });

  const temporary = `${path}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;

  if (secret) {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return;
  }

  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, path);
}

/** 秘密の JSON を書く（0600・ディレクトリ 0700）。 */
export function writePrivateJson(path: string, value: unknown, options: { createDirectory?: boolean } = {}): void {
  writeJson(path, value, { ...options, secret: true });
}

/** 秘密でないバイト列を、一時ファイル経由で置き換える（途中で落ちても元のファイルを壊さない）。 */
export function writeBinary(path: string, data: Uint8Array, options: { createDirectory?: boolean } = {}): void {
  if (options.createDirectory === true) mkdirSync(dirname(path), { recursive: true });

  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

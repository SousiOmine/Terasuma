import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describeError } from "../../shared/errors";

/**
 * 秘密を含む JSON ファイルの読み書き。
 *
 * 設定（config.json）、コネクタのトークン、MCP の OAuth の材料が、この同じ形を必要とする。
 * ディレクトリを 0700、ファイルを 0600 にし、一時ファイル経由で置き換える（書き込み中に落ちても
 * 元のファイルが壊れない）。権限の付け方を 1 か所にまとめ、片方だけ抜ける状態を作らない。
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

/**
 * 一時ファイルへ書いてから置き換える。途中で落ちても、元のファイルはそのまま残る。
 *
 * createDirectory は、置き場のディレクトリをこのファイルが持つ場合だけ付ける（トークンなど）。
 * 設定ファイルは起動時に ensureDirectories が作るので、無いときは失敗させる（黙って作り直さない）。
 */
export function writePrivateJson(path: string, value: unknown, options: { createDirectory?: boolean } = {}): void {
  if (options.createDirectory === true) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

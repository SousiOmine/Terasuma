import { writePrivateJson } from "../secret-file";
import { FILE_KEYS, type FileSettings } from "./types";

/**
 * 設定ファイルの書き込み。
 *
 * 一時ファイル経由で置き換え、0600 にする（プロバイダの API キーと環境変数が入るため）。
 * 項目の並びは FILE_KEYS の順に固定し、差分を読みやすくする。
 */

/**
 * 設定ファイルを書き換える。設定画面からの変更と、手で編集した内容の取り込みに使う。
 * 書き込みの途中で落ちても元のファイルが壊れないよう、一時ファイル経由で置き換える。
 * プロバイダの API キーとコンピュータの環境変数が入るので、他の利用者から読めないよう 0600 にする。
 */
export function writeSettingsFile(path: string, settings: FileSettings): void {
  writePrivateJson(path, orderedSettings(settings));
}

/** 設定ファイルに書く内容。項目の並びは FILE_KEYS の順に固定し、差分を読みやすくする。 */
function orderedSettings(settings: FileSettings): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};

  // 並びの正典は FILE_KEYS だけにする（ここに順序を書き写さない）。
  for (const key of FILE_KEYS) {
    const value = settings[key];
    if (value !== undefined) ordered[key] = value;
  }
  return ordered;
}

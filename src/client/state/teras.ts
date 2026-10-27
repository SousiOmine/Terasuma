import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { openTera } from "./chat";
import { t } from "../i18n";
import { activeTeraId, setTeras } from "./session";

/**
 * Tera の削除。
 *
 * 一覧を持つ session と、開いている Tera を決める chat の両方を触るので、
 * どちらにも置かず、相互 import を作らないここへまとめる。
 *
 * 消すと、履歴・identity・Discord の webhook・作業フォルダもサーバ側で消える（取り消せない）。
 * 最後の 1 体を消したときは、サーバが既定の Tera を作り直す。
 */

/** 消せなかったときの失敗。サイドバーと設定の両方が、それぞれの場所に出す。 */
const failure = createErrorSignal();
export const teraError = failure.error;
export const showTeraError = failure.show;
export const clearTeraError = failure.clear;

/**
 * Tera を消して、一覧を置き換える。
 * 開いていた Tera を消したら、残った先頭（最後の 1 体なら、作り直された既定の Tera）を開く。
 * 失敗は例外で返す（呼ぶ画面が、その画面のやり方で表示する）。
 */
export async function removeTera(teraId: string): Promise<void> {
  clearTeraError();

  const remaining = await api.deleteTera(teraId);
  setTeras(remaining);
  if (activeTeraId.value !== teraId) return;

  const next = remaining[0];
  if (next === undefined) throw new Error(t("error.tera_list_empty"));
  await openTera(next.id);
}

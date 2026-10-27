import { signal } from "@preact/signals";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";

/**
 * 設定 > Tera のルーチン（Tera が決まった時刻に自分から走らせるターン）の状態。
 *
 * 一覧は全 Tera 分を 1 本で読み、画面は Tera ごとに絞って出す。
 * 有効/無効・実行・停止・削除は、どれもサーバが返す最新の一覧で置き換える。
 * 操作中の id を持ち、その行のボタンだけを止める（別の行は触れる）。
 */

/** サーバーから読んだ一覧。まだ読めていないときは null。 */
export const routinesResource = createResource(api.fetchRoutines);
export const routines = routinesResource.data;
export const isLoadingRoutines = routinesResource.loading;
/** 一覧を読めなかった理由。「読み込み中」と区別して画面に出す。 */
export const routinesLoadError = routinesResource.error;

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const routinesError = failure.error;
export const showRoutinesError = failure.show;
export const clearRoutinesError = failure.clear;

/** いま操作しているルーチンの id。操作していないときは null。 */
export const savingRoutine = signal<string | null>(null);

/** 設定画面を開いたときに読む（まだ読めていなければ）。 */
export const loadRoutines = routinesResource.load;
/** 一覧を読み直す。 */
export const refreshRoutines = routinesResource.refresh;

/** 有効・無効を切り替える。 */
export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  savingRoutine.value = id;
  try {
    routinesResource.data.value = await api.setRoutineEnabled(id, enabled);
  } finally {
    savingRoutine.value = null;
  }
}

/** ルーチンを消す。 */
export async function removeRoutine(id: string): Promise<void> {
  savingRoutine.value = id;
  try {
    routinesResource.data.value = await api.deleteRoutine(id);
  } finally {
    savingRoutine.value = null;
  }
}

/** いま 1 回走らせる（開始だけ）。 */
export async function runNow(id: string): Promise<void> {
  savingRoutine.value = id;
  try {
    routinesResource.data.value = await api.runRoutine(id);
  } finally {
    savingRoutine.value = null;
  }
}

/** 走っているルーチンを止める。 */
export async function stopRun(id: string): Promise<void> {
  savingRoutine.value = id;
  try {
    routinesResource.data.value = await api.stopRoutine(id);
  } finally {
    savingRoutine.value = null;
  }
}

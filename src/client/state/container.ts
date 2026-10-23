import { signal } from "@preact/signals";
import type { ContainerStatusView } from "../../shared/api/settings";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";

/**
 * コンテナの状態と操作。
 *
 * 状態は podman への問い合わせの結果なので、Terasuma 側では覚えず、
 * 読み直したときと操作のたびにサーバが返した値をそのまま置く。
 */

/** サーバから読んだコンテナの状態。まだ読めていないときは null。 */
const statusResource = createResource(api.fetchContainer);
export const containerStatus = statusResource.data;
export const isLoadingContainer = statusResource.loading;

/** 設定画面から実行できる操作。 */
export type ContainerOperation = "start" | "reset";

/** 起動・リセットのいずれかを実行中かどうか。実行中の操作を持ち、ボタンの二重押しを防ぐ。 */
export const containerBusy = signal<ContainerOperation | null>(null);

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const containerError = failure.error;
export const showContainerError = failure.show;
export const clearContainerError = failure.clear;

/**
 * コンピュータのコマンドへ渡す環境変数の名前。
 * 値はサーバから返らない（画面にもモデルにも出さない）。まだ読めていないときは null。
 */
const envResource = createResource(api.fetchComputerEnv);
export const computerEnv = envResource.data;

/** 設定されている環境変数の名前を読む（まだ読めていなければ）。 */
export const loadComputerEnv = envResource.load;
/** 名前の一覧を読み直す。 */
export const refreshComputerEnv = envResource.refresh;

/** 環境変数を消す。サーバが返した、残っている名前の一覧をそのまま置く。 */
export async function removeComputerEnv(name: string): Promise<void> {
  computerEnv.value = await api.deleteComputerEnv(name);
}

/** 状態を読む（まだ読めていなければ）。 */
export const loadContainer = statusResource.load;
/** 状態を読み直す（操作の後や、読み込み直しボタン）。 */
export const refreshContainer = statusResource.refresh;

export async function startContainer(): Promise<void> {
  await run("start", api.startContainer);
}

export async function resetContainer(wipeHome: boolean): Promise<void> {
  await run("reset", () => api.resetContainer(wipeHome));
}

/**
 * 操作はどれも「実行中にする → サーバが返した状態を置く」の形にする。
 * 初回の起動はイメージの build を含むため、待っている間も画面には実行中と出る。
 */
async function run(operation: ContainerOperation, call: () => Promise<ContainerStatusView>): Promise<void> {
  containerBusy.value = operation;
  try {
    containerStatus.value = await call();
  } finally {
    containerBusy.value = null;
  }
}

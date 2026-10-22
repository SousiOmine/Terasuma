import { signal } from "@preact/signals";
import type { ContainerStatusView } from "../../shared/types";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";

/**
 * コンテナの状態と操作。
 *
 * 状態は podman への問い合わせの結果なので、Terasuma 側では覚えず、
 * 読み直したときと操作のたびにサーバが返した値をそのまま置く。
 */

/** サーバから読んだコンテナの状態。まだ読めていないときは null。 */
export const containerStatus = signal<ContainerStatusView | null>(null);

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
export const computerEnv = signal<readonly string[] | null>(null);

/** 設定されている環境変数の名前を読み直す。 */
export async function loadComputerEnv(): Promise<void> {
  computerEnv.value = await api.fetchComputerEnv();
}

/** 環境変数を消す。サーバが返した、残っている名前の一覧をそのまま置く。 */
export async function removeComputerEnv(name: string): Promise<void> {
  computerEnv.value = await api.deleteComputerEnv(name);
}

/** いまの状態を読み直す。 */
export async function loadContainer(): Promise<void> {
  containerStatus.value = await api.fetchContainer();
}

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

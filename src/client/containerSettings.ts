import { signal } from "@preact/signals";
import type { ContainerStatusView } from "../shared/types";
import * as api from "./api";
import { toErrorState, type ErrorState } from "./errors";

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
export const containerError = signal<ErrorState | null>(null);

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

export function showContainerError(error: unknown): void {
  containerError.value = toErrorState(error);
}

export function clearContainerError(): void {
  containerError.value = null;
}

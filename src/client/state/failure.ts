import { createErrorSignal } from "../lib/errors";

/**
 * チャットの失敗。チャットと引き受けの両方が同じ失敗を画面へ出すので、
 * どちらからも独立したモジュールに置く（相互 import を作らないため）。
 */
const failure = createErrorSignal();

export const chatError = failure.error;
export const showChatError = failure.show;
export const clearChatError = failure.clear;

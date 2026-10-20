import { signal, type Signal } from "@preact/signals";
import { ApiError, type ClientErrorCode } from "./http";

/**
 * 画面に出す失敗。
 *
 * 4 つの画面（チャット・モデル・MCP・コンテナ）が同じ形の状態を持つため、
 * 作る・入れる・消すをここに 1 つだけ置く。
 */

/** 画面に出す失敗の内容。文言は i18n の "error.<code>" から引く。 */
export type ErrorState = {
  code: ClientErrorCode;
  detail: string | null;
};

/** 例外を、画面に出せる形へ揃える。 */
export function toErrorState(error: unknown): ErrorState {
  if (error instanceof ApiError) return { code: error.code, detail: error.detail };
  return { code: "internal_error", detail: error instanceof Error ? error.message : String(error) };
}

/** 失敗を 1 つ持つ状態。 */
export type ErrorSignal = {
  readonly error: Signal<ErrorState | null>;
  show(error: unknown): void;
  clear(): void;
};

export function createErrorSignal(): ErrorSignal {
  const error = signal<ErrorState | null>(null);

  return {
    error,
    show(failure) {
      error.value = toErrorState(failure);
    },
    clear() {
      error.value = null;
    },
  };
}

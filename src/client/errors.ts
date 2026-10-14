import type { ClientErrorCode } from "./api";
import { ApiError } from "./api";

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

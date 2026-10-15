import type { ApiErrorCode } from "../shared/types";

/** エラーはコードで返し、画面に出す文言はクライアント側の i18n に任せる。 */
export function jsonError(status: number, code: ApiErrorCode, detail?: string): Response {
  return Response.json({ code, detail: detail ?? null }, { status });
}

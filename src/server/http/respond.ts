import { describeError } from "../../shared/errors";
import { ERROR_STATUS, type ApiErrorCode } from "../../shared/api/error";
import { AppError } from "../errors";
import { requireClientForMutation } from "./client-id";
import { SECURITY_HEADERS } from "./security";

/**
 * HTTP の応答を作る。失敗の変換も、ハンドラの包み方もここに集める。
 * ハンドラは「成功したときの応答を返す」か「失敗を投げる」だけを書く。
 */

/** JSON の応答。 */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: SECURITY_HEADERS });
}

/** 本文を持たない成功（204）。 */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: SECURITY_HEADERS });
}

/** 画面が文言を選べる形の失敗。状態はコードから決まる（ERROR_STATUS）。 */
export function jsonError(code: ApiErrorCode, detail?: string): Response {
  return json({ code, detail: detail ?? null }, ERROR_STATUS[code]);
}

/**
 * 例外を、画面が読める応答にする。
 * 知っている失敗（AppError）はその code と status をそのまま使い、
 * 知らない例外は 500 にまとめる（内部の詳細は detail に残す）。
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) return jsonError(error.code, error.message);
  return jsonError("internal_error", describeError(error));
}

/** ハンドラ 1 つを、例外を応答に変える形で包む。 */
function handle<Args extends unknown[]>(
  handler: (...args: Args) => Response | Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      // 変更系は、画面の id を付けた要求だけを受け付ける（CSRF の門）。
      requireClientForMutation(args[0]);
      return await handler(...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** ハンドラの集まりを、まとめて handle で包んだ後の型。ルート表はこれを受け取る。 */
export type WithErrorHandling<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => Response | Promise<Response>
    ? (...args: Args) => Promise<Response>
    : T[K];
};

/** ハンドラの集まりを、まとめて handle で包む。 */
export function withErrorHandling<T extends Record<string, unknown>>(handlers: T): WithErrorHandling<T> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(handlers)) {
    wrapped[name] = typeof value === "function" ? handle(value as (...args: unknown[]) => Response) : value;
  }
  return wrapped as WithErrorHandling<T>;
}

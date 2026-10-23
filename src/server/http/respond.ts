import { describeError } from "../../shared/errors";
import type { ApiErrorCode } from "../../shared/api/error";
import { AppError } from "../errors";

/**
 * HTTP の応答を作る。失敗の変換も、ハンドラの包み方もここに集める。
 * ハンドラは「成功したときの応答を返す」か「失敗を投げる」だけを書く。
 */

/** JSON の応答。 */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** 本文を持たない成功（204）。 */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** 画面が文言を選べる形の失敗。 */
export function jsonError(status: number, code: ApiErrorCode, detail?: string): Response {
  return json({ code, detail: detail ?? null }, status);
}

/**
 * 例外を、画面が読める応答にする。
 * 知っている失敗（AppError）はその code と status をそのまま使い、
 * 知らない例外は 500 にまとめる（内部の詳細は detail に残す）。
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) return jsonError(error.status, error.code, error.message);
  return jsonError(500, "internal_error", describeError(error));
}

/** ハンドラ 1 つを、例外を応答に変える形で包む。 */
function handle<Args extends unknown[]>(
  handler: (...args: Args) => Response | Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
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

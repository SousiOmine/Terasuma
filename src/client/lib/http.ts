import { describeError } from "../../shared/errors";
import { API_ERROR_CODES, type ApiErrorCode } from "../../shared/types";

/**
 * HTTP の入り口。
 *
 * 「fetch する → 通信の失敗と HTTP の失敗を ApiError に揃える」という形は
 * どの呼び出しでも同じになる。3 か所に書き写さず、ここに 1 つだけ置く。
 */

/** サーバが返すコードに、クライアント側だけで発生するコードを足したもの。 */
export type ClientErrorCode = ApiErrorCode | "network" | "input" | "mcp_unreachable";

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly detail: string | null;

  constructor(code: ClientErrorCode, detail: string | null = null) {
    super(detail ?? code);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * fetch して、失敗を ApiError に揃える。
 * 中断（利用者の「停止」）は失敗ではないので、そのまま投げて呼び出し側に任せる。
 */
export async function fetchOrThrow(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (init?.signal?.aborted === true) throw error;
    throw new ApiError("network", describeError(error));
  }

  if (!response.ok) throw await toApiError(response);
  return response;
}

/** JSON を読む呼び出し。応答の形の検証は境界（schema）で行う。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchOrThrow(path, init);
  return (await response.json()) as T;
}

/** JSON を送るリクエストの共通部分。中断（停止）を渡したいときは signal も付ける。 */
export function jsonRequest(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  };
}

/** 失敗の応答を、画面が扱える ApiError にする。 */
async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown };
    const code: ClientErrorCode = isApiErrorCode(body.code) ? body.code : "internal_error";
    const detail = typeof body.detail === "string" ? body.detail : `HTTP ${response.status}`;
    return new ApiError(code, detail);
  } catch {
    // 本文が JSON でない場合（404 のプレーンテキストなど）
    return new ApiError("internal_error", `HTTP ${response.status}`);
  }
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

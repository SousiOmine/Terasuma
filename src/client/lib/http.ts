import { describeError } from "../../shared/errors";
import { API_ERROR_CODES, type ApiErrorCode } from "../../shared/api/error";
import { CLIENT_HEADER } from "../../shared/api/events";

/**
 * HTTP の入り口。
 *
 * 「fetch する → 通信の失敗と HTTP の失敗を ApiError に揃える」という形は
 * どの呼び出しでも同じになる。3 か所に書き写さず、ここに 1 つだけ置く。
 */

/** サーバが返すコードに、クライアント側だけで発生するコードを足したもの。 */
/**
 * サーバの codes に足す、画面の中だけで起きる失敗。
 * 文言は error.<code> で引くので、辞書にも同じだけ並べる（i18n のテストが突き合わせる）。
 */
export const CLIENT_ERROR_CODES = [
  /** サーバに繋がらない。 */
  "network",
  /** 画面の入力が受け付けられない。 */
  "input",
  /** MCP サーバーに繋がらない。 */
  "mcp_unreachable",
  /** 応答が終わりの合図なしに切れた。 */
  "stream_ended",
  /** 一覧の読み直しをしたら、Tera が 1 体も残っていなかった。 */
  "tera_list_empty",
  /** 操作の対象の Tera が、画面の持つ一覧に無い。 */
  "tera_unknown",
] as const;

export type ClientErrorCode = ApiErrorCode | (typeof CLIENT_ERROR_CODES)[number];

/**
 * この画面（タブ）の id。読み込みごとに作り、すべての要求に付ける。
 * サーバは、この画面が購読している流れへ、この画面の送信を二重に流さない。
 * 変更系の API では CSRF の門にもなる（独自ヘッダを付けた cross-origin の要求は
 * プリフライトで止まる）。
 *
 * crypto.randomUUID は安全な接続（HTTPS か localhost）でしか使えないため、
 * 画面を見分けるだけのこの値は、どこでも使える getRandomValues で作る。
 */
const clientId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");

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
  // 変更系の API は、画面の id を付けた要求だけを受け付ける（CSRF の門）。
  // WebSocket はヘッダを付けられないので、画面のトークンで別に守る。
  const headers = new Headers(init?.headers);
  headers.set(CLIENT_HEADER, clientId);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (init?.signal?.aborted === true) throw error;
    throw new ApiError("network", describeError(error));
  }

  if (!response.ok) throw await toApiError(response);
  return response;
}

/**
 * JSON を読む呼び出し。
 * 応答の形はサーバとの契約（shared/api）が決める。ここでは JSON として読むだけにする
 * （画面が読む直前に形を疑うのは、契約が壊れたときの原因を分かりにくくするため）。
 */
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

/**
 * プロバイダへの JSON の問い合わせ。
 *
 * 打ち切り（タイムアウトと呼び出し元の中断）と、HTTP の状態から失敗の種類を決める処理を、
 * すべてのプロバイダで同じにする。プロバイダごとの差は、URL・ヘッダー・本文・応答の読み方だけ。
 */

import { MAX_ERROR_DETAIL_CHARS } from "./constants";
import { WebSearchError } from "./errors";
import { errorMessage } from "./text";
import type { FetchLike } from "./types";

export type JsonRequestOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /** 失敗の文言に添える名前（"Exa" など）。 */
  provider: string;
};

/** タイムアウトと、呼び出し元の中断を 1 つの signal にまとめる。 */
export function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** JSON を投げて、JSON を受け取る。失敗は WebSearchError にする。 */
export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: JsonRequestOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: combineSignal(options.signal, options.timeoutMs) });
  } catch (error) {
    throw networkError(options.provider, error);
  }

  if (!response.ok) {
    throw responseError(options.provider, response.status, await readErrorBody(response));
  }

  try {
    return await response.json();
  } catch (error) {
    throw new WebSearchError("unavailable", `${options.provider} returned a response that is not JSON`, {
      status: response.status,
      cause: error,
    });
  }
}

/** 失敗の応答から、読める文言を取り出す。読めなくても空文字で続ける。 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** HTTP の状態を、失敗の種類にする。 */
function responseError(provider: string, status: number, body: string): WebSearchError {
  const detail = errorDetail(body);
  const suffix = detail.length === 0 ? "" : `: ${detail}`;
  const message = `${provider} returned HTTP ${status}${suffix}`;

  if (status === 401 || status === 403) return new WebSearchError("auth", message, { status });
  if (status === 429) return new WebSearchError("rate_limit", message, { status });
  if (status === 402) return new WebSearchError("quota", message, { status });
  if (status >= 400 && status < 500) return new WebSearchError("invalid", message, { status });
  return new WebSearchError("unavailable", message, { status });
}

/**
 * エラー本文から、モデルと利用者が読める 1 文を取り出す。
 * プロバイダごとに形が違う（error.message / detail / message）ので、見つかったものを使う。
 */
function errorDetail(body: string): string {
  const text = body.trim();
  if (text.length === 0) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return truncate(text, MAX_ERROR_DETAIL_CHARS);
  }

  const record = asRecord(parsed);
  if (record === null) return truncate(text, MAX_ERROR_DETAIL_CHARS);

  const fromError = messageOf(record["error"]);
  if (fromError !== null) return truncate(fromError, MAX_ERROR_DETAIL_CHARS);

  const fromDetail = messageOf(record["detail"]);
  if (fromDetail !== null) return truncate(fromDetail, MAX_ERROR_DETAIL_CHARS);

  const fromMessage = messageOf(record["message"]);
  if (fromMessage !== null) return truncate(fromMessage, MAX_ERROR_DETAIL_CHARS);

  return truncate(text, MAX_ERROR_DETAIL_CHARS);
}

/** 文字列・{ message }・配列（Perplexity の 422）から文言を取り出す。 */
function messageOf(value: unknown): string | null {
  if (typeof value === "string") return value.length === 0 ? null : value;

  if (Array.isArray(value)) {
    const messages = value.map(messageOf).filter((item): item is string => item !== null);
    return messages.length === 0 ? null : messages.join("; ");
  }

  const record = asRecord(value);
  if (record === null) return null;

  for (const key of ["message", "error", "msg"] as const) {
    const message = messageOf(record[key]);
    if (message !== null) return message;
  }
  return null;
}

/** 通信そのものができなかったときの失敗。 */
function networkError(provider: string, error: unknown): WebSearchError {
  const name = error instanceof Error ? error.name : "";

  if (name === "TimeoutError") {
    return new WebSearchError("unavailable", `${provider} did not respond in time`, { cause: error });
  }
  if (name === "AbortError") {
    return new WebSearchError("unavailable", `${provider} request was aborted`, { cause: error });
  }

  return new WebSearchError("unavailable", `${provider} could not be reached: ${errorMessage(error)}`, {
    cause: error,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

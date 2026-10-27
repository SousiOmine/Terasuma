/**
 * プロバイダへの JSON の問い合わせ。
 *
 * 打ち切り（タイムアウトと呼び出し元の中断）と、HTTP の状態から失敗の種類を決める処理を、
 * すべてのプロバイダで同じにする。プロバイダごとの差は、URL・ヘッダー・本文・応答の読み方だけ。
 */

import { readErrorDetail, sendRequestOrThrow } from "../http/client";
import { MAX_ERROR_DETAIL_CHARS } from "./constants";
import { WebSearchError } from "./errors";
import { describeError } from "../../shared/errors";
import type { FetchLike } from "./types";

export type JsonRequestOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /** 失敗の文言に添える名前（"Exa" など）。 */
  provider: string;
};

/** JSON を投げて、JSON を受け取る。失敗は WebSearchError にする。 */
export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: JsonRequestOptions,
): Promise<unknown> {
  const response = await sendRequestOrThrow(fetchImpl, url, init, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onNetwork: (error) => networkError(options.provider, error),
  });
  if (!response.ok) {
    throw responseError(options.provider, response.status, await readErrorDetail(response, MAX_ERROR_DETAIL_CHARS));
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

/** HTTP の状態を、失敗の種類にする。 */
function responseError(provider: string, status: number, detail: string): WebSearchError {
  const suffix = detail.length === 0 ? "" : `: ${detail}`;
  const message = `${provider} returned HTTP ${status}${suffix}`;

  if (status === 401 || status === 403) return new WebSearchError("auth", message, { status });
  if (status === 429) return new WebSearchError("rate_limit", message, { status });
  if (status === 402) return new WebSearchError("quota", message, { status });
  if (status >= 400 && status < 500) return new WebSearchError("invalid", message, { status });
  return new WebSearchError("unavailable", message, { status });
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

  return new WebSearchError("unavailable", `${provider} could not be reached: ${describeError(error)}`, {
    cause: error,
  });
}

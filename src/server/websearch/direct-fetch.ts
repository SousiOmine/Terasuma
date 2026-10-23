/**
 * 取得 API を持たないプロバイダのための、ページの直接取得。
 *
 * Brave と Perplexity は検索だけを提供するので、本文は Terasuma が URL を取得して
 * HTML をテキストにする。PDF や画像は本文にできないため、失敗として返す。
 */

import { MAX_DIRECT_FETCH_BYTES, MAX_DIRECT_FETCH_CHARS } from "./constants";
import { WebSearchError } from "./errors";
import { htmlToText, pageTitle } from "./html";
import { combineSignal } from "../http/client";
import { describeError } from "../../shared/errors";
import type { FetchLike, FetchRequest, FetchResponse } from "./types";

/** 直接取得の打ち切り。 */
const DIRECT_TIMEOUT_MS = 20_000;

const USER_AGENT = "Terasuma/0.1";
const ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5";

/** URL を取得して、読める本文にする。 */
export async function fetchDirect(fetchImpl: FetchLike, request: FetchRequest): Promise<FetchResponse> {
  const url = httpUrl(request.url);
  const signal = combineSignal(request.signal, DIRECT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: ACCEPT, "User-Agent": USER_AGENT },
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new WebSearchError("unavailable", `The page did not respond in time (${url})`, { cause: error });
    }
    throw new WebSearchError("unavailable", `The page could not be fetched: ${describeError(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    // 404 は URL の誤りであることが多いので、直せる失敗として返す。
    const code = response.status === 404 || response.status === 410 ? "invalid" : "unavailable";
    throw new WebSearchError(code, `The page returned HTTP ${response.status} (${url})`, {
      status: response.status,
    });
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    throw new WebSearchError("unsupported", "The URL is a PDF, which direct fetching cannot read as text.");
  }

  const body = await readBody(response, url);
  const finalUrl = response.url.length > 0 ? response.url : url;

  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return { url: finalUrl, title: pageTitle(body), text: htmlToText(body) };
  }

  if (isPlainText(contentType)) {
    return { url: finalUrl, title: null, text: body.trim() };
  }

  throw new WebSearchError("unsupported", `The URL returned ${contentType || "an unknown type"}, which is not text.`);
}

/** http と https だけを受け付ける。ファイルやスクリプトの URL は取得しない。 */
function httpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new WebSearchError("invalid", `Not a valid URL: ${value}`, { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebSearchError("invalid", `Only http and https URLs can be fetched (got ${url.protocol})`);
  }
  return url.toString();
}

/** 本文として読める種類かどうか。Content-Type が無い応答も、本文をそのまま返す。 */
function isPlainText(contentType: string): boolean {
  return (
    contentType === "" ||
    contentType.startsWith("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/javascript")
  );
}

/** 大きすぎる応答は読み切らずに止める（メモリを使い切らないため）。 */
async function readBody(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DIRECT_FETCH_BYTES) {
    throw tooLarge(url);
  }

  const text = await response.text();
  if (text.length > MAX_DIRECT_FETCH_CHARS) throw tooLarge(url);
  return text;
}

function tooLarge(url: string): WebSearchError {
  const megabytes = Math.trunc(MAX_DIRECT_FETCH_BYTES / (1024 * 1024));
  return new WebSearchError("unavailable", `The page is larger than ${megabytes} MB (${url})`);
}

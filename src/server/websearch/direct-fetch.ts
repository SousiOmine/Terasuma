/**
 * 取得 API を持たないプロバイダのための、ページの直接取得。
 *
 * Brave と Perplexity は検索だけを提供するので、本文は Terasuma が URL を取得して
 * HTML をテキストにする。PDF や画像は本文にできないため、失敗として返す。
 */

import { MAX_DIRECT_FETCH_BYTES, MAX_DIRECT_FETCH_CHARS } from "./constants";
import { WebSearchError } from "./errors";
import { htmlToText, pageTitle } from "./html";
import { combineSignal } from "../../shared/async";
import { describeError } from "../../shared/errors";
import type { FetchLike, FetchRequest, FetchResponse } from "./types";

/** 直接取得の打ち切り。 */
const DIRECT_TIMEOUT_MS = 20_000;

const USER_AGENT = "Terasuma/0.1";
const ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5";

/** リダイレクトを追う上限。 */
const MAX_REDIRECTS = 5;

/** URL を取得して、読める本文にする。 */
export async function fetchDirect(fetchImpl: FetchLike, request: FetchRequest): Promise<FetchResponse> {
  let url = httpUrl(request.url);
  const signal = combineSignal(request.signal, DIRECT_TIMEOUT_MS);

  let response: Response;
  let redirects = 0;
  for (;;) {
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: ACCEPT, "User-Agent": USER_AGENT },
        // リダイレクトは自分で追う。飛び先も httpUrl で確かめるため。
        redirect: "manual",
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

    if (!isRedirect(response.status)) break;

    const location = response.headers.get("location");
    if (location === null) {
      throw new WebSearchError("unavailable", `The page redirected without a Location header (${url})`);
    }

    redirects += 1;
    if (redirects > MAX_REDIRECTS) {
      throw new WebSearchError("unavailable", `The page redirected more than ${MAX_REDIRECTS} times (${url})`);
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch (error) {
      throw new WebSearchError("invalid", `The redirect target is not a valid URL: ${location}`, { cause: error });
    }
    url = httpUrl(next.toString());
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
  // リダイレクトは自分で追っているので、最後に取得した URL が最終的な取得先になる。
  const finalUrl = url;

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
  if (isPrivateHost(url.hostname)) {
    throw new WebSearchError(
      "invalid",
      `Local and private addresses cannot be fetched (${url.hostname}). Use a public URL.`,
    );
  }
  return url.toString();
}

/** リダイレクトとして追う応答かどうか。 */
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * この端末や同じネットワークの中を指すアドレスかどうか。
 * SSRF と、Terasuma 自身の API（localhost で認証なし）をエージェントに読ませないための線引き。
 *
 * URL は IPv4 の別表記（127.1、2130706433、0x7f000001）を点付き 10 進へ直すので、
 * ここでは正規化後の文字列だけを見ればよい。IPv6 は、URL が [::ffff:127.0.0.1] を
 * [::ffff:7f00:1] へ直すため、IPv4 埋め込み（::ffff:0:0/96 と ::/96）を 16 bit ずつ読む。
 * DNS の解決結果までは見ないので、名前が後から private な IP を指す場合までは塞げない。
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // URL の hostname は IPv6 を角括弧で囲む。ゾーン id（%25eth0）はアドレスではないので落とす。
  const address = (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host).split("%")[0] ?? "";

  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);

  const groups = parseIpv6(address);
  if (groups === null) return false;

  // ::（未指定）と ::1（loopback）。
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;

  // IPv4-mapped（::ffff:0:0/96）と IPv4-compatible（::/96）。
  if (isZeroPrefix(groups, 5) && groups[5] === 0xffff) return isPrivateIpv4(groupsToIpv4(groups));
  if (isZeroPrefix(groups, 6)) return isPrivateIpv4(groupsToIpv4(groups));

  // fc00::/7（unique local）、fe80::/10（link-local）、fec0::/10（site-local）、ff00::/8（multicast）。
  const first = groups[0] ?? 0;
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  if (first >= 0xfe80 && first <= 0xfeff) return true;
  if (first >= 0xff00) return true;

  // NAT64（64:ff9b::/96 と、ローカル用の 64:ff9b:1::/48）に埋め込まれた IPv4。
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isPrivateIpv4(groupsToIpv4(groups));
  }
  if (first === 0x64 && groups[1] === 0xff9b && groups[2] === 1 && groups.slice(3, 6).every((group) => group === 0)) {
    return isPrivateIpv4(groupsToIpv4(groups));
  }

  return false;
}

/** 点付き 10 進の IPv4。URL が正規化した後の値だけを受ける。 */
function parseIpv4(value: string): readonly number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (match === null) return null;

  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

/** IPv6 を 8 個の 16 bit に開く。IPv4 埋め込みの末尾（::ffff:127.0.0.1）も読む。 */
function parseIpv6(value: string): readonly number[] | null {
  if (!value.includes(":")) return null;

  const [head, tail, ...rest] = value.split("::");
  if (rest.length > 0) return null;

  const headGroups = parseIpv6Groups(head ?? "");
  if (headGroups === null) return null;

  // "::" が無いときは、8 個そろっているものだけを受け付ける。
  if (tail === undefined) return headGroups.length === 8 ? headGroups : null;

  const tailGroups = parseIpv6Groups(tail);
  if (tailGroups === null) return null;

  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 1) return null;
  return [...headGroups, ...Array<number>(missing).fill(0), ...tailGroups];
}

function parseIpv6Groups(value: string): readonly number[] | null {
  if (value.length === 0) return [];

  const pieces = value.split(":");
  const groups: number[] = [];

  for (const [index, piece] of pieces.entries()) {
    // 末尾だけは、IPv4 を 2 個の 16 bit として埋め込める。
    if (index === pieces.length - 1 && piece.includes(".")) {
      const ipv4 = parseIpv4(piece);
      if (ipv4 === null) return null;
      groups.push(((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0), ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0));
      continue;
    }

    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups;
}

function isZeroPrefix(groups: readonly number[], count: number): boolean {
  return groups.slice(0, count).every((group) => group === 0);
}

function groupsToIpv4(groups: readonly number[]): readonly number[] {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** この端末や同じネットワークの中を指す IPv4 かどうか。 */
function isPrivateIpv4(parts: readonly number[]): boolean {
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
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

/**
 * 大きすぎる応答は読み切らずに止める（メモリを使い切らないため）。
 * Content-Length は chunked では付かないので、本文を読みながらバイト数を数え、
 * 上限を超えた時点で読むのをやめる。
 */
async function readBody(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DIRECT_FETCH_BYTES) {
    throw tooLarge(url);
  }

  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      bytes += value.byteLength;
      if (bytes > MAX_DIRECT_FETCH_BYTES) {
        await reader.cancel();
        throw tooLarge(url);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (text.length > MAX_DIRECT_FETCH_CHARS) throw tooLarge(url);
  return text;
}

function tooLarge(url: string): WebSearchError {
  const megabytes = Math.trunc(MAX_DIRECT_FETCH_BYTES / (1024 * 1024));
  return new WebSearchError("unavailable", `The page is larger than ${megabytes} MB (${url})`);
}

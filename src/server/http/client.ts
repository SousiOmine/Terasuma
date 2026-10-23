import { describeError } from "../../shared/errors";

/**
 * 外部の HTTP API への問い合わせ。
 *
 * タイムアウトと呼び出し元の中断の合成、通信できなかったときの扱い、失敗の応答から
 * 読める 1 文を取り出す処理を、ここに 1 つだけ置く。どの API もこの形で呼び、
 * 失敗を自分のエラー型へ読み替える（WebSearchError、ProviderRequestError など）。
 */

/** fetch の差し替え口。テストでは通信せずに応答を返せる。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 問い合わせの結果。通信そのものができなかった場合と、応答が返った場合を分ける。 */
export type FetchOutcome =
  | { kind: "response"; response: Response }
  | { kind: "network"; error: unknown; timedOut: boolean };

/** タイムアウトと、呼び出し元の中断を 1 つの signal にまとめる。 */
export function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * 1 回の問い合わせ。通信の失敗は投げずに結果で返す（呼び出し側が自分のエラー型へ変える）。
 * 応答が返れば、状態コードが何であっても response として返す。
 */
export async function sendRequest(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<FetchOutcome> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

  try {
    return { kind: "response", response: await fetchImpl(url, { ...init, signal }) };
  } catch (error) {
    return { kind: "network", error, timedOut: timeout.aborted };
  }
}

/** 失敗の応答から、読める 1 文を取り出す。読めなければ空文字。 */
export async function readErrorDetail(response: Response, limit: number): Promise<string> {
  try {
    return errorDetailFromText(await response.text(), limit);
  } catch {
    return "";
  }
}

/**
 * 失敗の本文から 1 文を取り出す。
 * プロバイダごとに形が違う（error / error.message / detail / message）ので、見つかったものを使う。
 * どれも無ければ、本文を 1 行に詰めて上限で切る。
 */
export function errorDetailFromText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return oneLine(trimmed, limit);
  }

  return oneLine(findMessage(parsed) ?? trimmed, limit);
}

/** 文字列・配列・入れ子のオブジェクトから、人が読める文言を探す。 */
function findMessage(value: unknown): string | null {
  if (typeof value === "string") return value.length === 0 ? null : value;

  if (Array.isArray(value)) {
    const messages = value.map(findMessage).filter((message): message is string => message !== null);
    return messages.length === 0 ? null : messages.join("; ");
  }

  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  for (const key of ["error", "detail", "message", "msg"] as const) {
    const message = findMessage(record[key]);
    if (message !== null) return message;
  }
  return null;
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 通信そのものができなかった理由を、短い 1 文にする。 */
export function describeNetworkError(error: unknown): string {
  return describeError(error);
}

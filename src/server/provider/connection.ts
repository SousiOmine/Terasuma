/**
 * プロバイダへ接続できるかどうかを確かめる。
 *
 * 使えるモデルの一覧は models.dev のカタログから取るので、ここで見るのは「登録した資格でそのプロバイダに
 * 届くか」だけ。ただし /models を公開していないプロバイダもあるため、確かめられなかった場合は
 * 失敗にせず「確認できなかった」として返す（設定への保存は妨げない）。
 * API キーが違えば 401/403 が返るので、そこは今までどおり失敗として止める。
 *
 * 独自エンドポイント（OpenAI 互換）はカタログに無いので、モデルの一覧もここから取る。
 */
import type { ApiErrorCode, ProviderCheckResult } from "../../shared/types";
import { describeError } from "../../shared/errors";

/** 接続確認で返す失敗の種類。ルート側でそのまま API のコードになる。 */
export type ProviderErrorCode = Extract<
  ApiErrorCode,
  "provider_auth_failed" | "provider_unreachable" | "provider_no_models"
>;

export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderRequestError";
    this.code = code;
  }
}

/**
 * プロバイダへ投げる fetch の形。ここで使う引数だけに絞ってあるので、テストでは素の関数を渡せる。
 */
export type FetchLike = (
  input: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/** 応答が返らないまま待ち続けないための上限。 */
export const CONNECTION_TIMEOUT_MS = 20_000;

/** どこへどう問い合わせるか。 */
export type ConnectionTarget = {
  url: string;
  /** 認証ヘッダの当て方。 */
  auth: "bearer" | "x-api-key";
  /** 一覧を取るときに足すヘッダ（Anthropic のバージョン指定など）。 */
  headers?: Record<string, string>;
};

/** 問い合わせる相手と資格。 */
export type ProviderRequest = {
  /** null は「確認する宛先が分からない」を表す。 */
  target: ConnectionTarget | null;
  apiKey: string | null;
  signal?: AbortSignal;
};

/** 確認の結果。verified が false のときは、確かめる手段が無かったことを表す。 */
export type ConnectionChecker = (request: ProviderRequest) => Promise<ProviderCheckResult>;

/** 独自エンドポイントのモデル一覧を取る関数。 */
export type ProviderModelLister = (request: ProviderRequest) => Promise<readonly string[]>;

/**
 * models.dev に api が無いプロバイダ向けの一覧 URL。
 * ここに無く api も無いものは、確認せずに保存できる。
 */
const KNOWN_MODELS_URLS: Record<string, ConnectionTarget> = {
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer" },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    auth: "x-api-key",
    headers: { "anthropic-version": "2023-06-01" },
  },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/openai/models", auth: "bearer" },
  xai: { url: "https://api.x.ai/v1/models", auth: "bearer" },
  groq: { url: "https://api.groq.com/openai/v1/models", auth: "bearer" },
  mistral: { url: "https://api.mistral.ai/v1/models", auth: "bearer" },
  cerebras: { url: "https://api.cerebras.ai/v1/models", auth: "bearer" },
  deepinfra: { url: "https://api.deepinfra.com/v1/openai/models", auth: "bearer" },
  togetherai: { url: "https://api.together.xyz/v1/models", auth: "bearer" },
  vercel: { url: "https://ai-gateway.vercel.sh/v1/models", auth: "bearer" },
};

/**
 * 接続確認の宛先を決める。確認する手段が無ければ null。
 * - 独自エンドポイント（baseUrl あり）はその URL
 * - カタログのプロバイダは models.dev の api
 */
export function connectionTarget(input: {
  id: string;
  baseUrl: string | null;
  api: string | null;
}): ConnectionTarget | null {
  if (input.baseUrl !== null) return { url: `${input.baseUrl}/models`, auth: "bearer" };

  const known = KNOWN_MODELS_URLS[input.id];
  if (known !== undefined) return known;

  if (input.api === null) return null;
  return { url: `${input.api.replace(/\/+$/, "")}/models`, auth: "bearer" };
}

/** 一覧を公開していないと判断する状態。 */
const UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

/** 問い合わせの結果。unsupported は「宛先はあるが一覧を返さない」ことを表す。 */
type ProbeOutcome = { status: "ok"; ids: readonly string[] } | { status: "unsupported" };

async function probeModels(fetchImpl: FetchLike, request: ProviderRequest): Promise<ProbeOutcome> {
  const target = request.target;
  if (target === null) throw new ProviderRequestError("provider_unreachable", "接続先が分かりません");

  const headers: Record<string, string> = { Accept: "application/json", ...target.headers };
  if (request.apiKey !== null && request.apiKey.length > 0) {
    if (target.auth === "x-api-key") headers["x-api-key"] = request.apiKey;
    else headers["Authorization"] = `Bearer ${request.apiKey}`;
  }

  const timeout = AbortSignal.timeout(CONNECTION_TIMEOUT_MS);
  const abort = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

  let response: Response;
  try {
    response = await fetchImpl(target.url, { headers, signal: abort });
  } catch (error) {
    if (timeout.aborted) {
      throw new ProviderRequestError(
        "provider_unreachable",
        `${target.url} から ${CONNECTION_TIMEOUT_MS / 1000} 秒以内に応答がありません`,
      );
    }
    throw new ProviderRequestError("provider_unreachable", `${target.url} に接続できません: ${describeError(error)}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const detail = await readFailureDetail(response);
      throw new ProviderRequestError("provider_auth_failed", detail ?? `HTTP ${response.status}`);
    }
    // 一覧を公開していないだけかもしれない。確認できなかったものとして扱う。
    if (UNSUPPORTED_STATUSES.has(response.status)) return { status: "unsupported" };

    const detail = await readFailureDetail(response);
    throw new ProviderRequestError(
      "provider_unreachable",
      `HTTP ${response.status}${detail === null ? "" : `: ${detail}`}`,
    );
  }

  const ids = await readModelIds(response);
  // 一覧の形をしていなければ、確認できたとは言えない。
  if (ids === null) return { status: "unsupported" };
  return { status: "ok", ids };
}

/**
 * 接続確認。資格が通ったかどうかを返す。
 * 宛先が分からない（確認手段が無い）場合も、失敗にはせず verified: false として返す。
 */
export function createConnectionChecker(fetchImpl: FetchLike = fetch): ConnectionChecker {
  return async (request) => {
    if (request.target === null) return { verified: false, models: [] };
    const outcome = await probeModels(fetchImpl, request);
    if (outcome.status === "unsupported") return { verified: false, models: [] };
    return { verified: true, models: outcome.ids };
  };
}

/** 独自エンドポイントのモデル一覧。カタログに無い接続先のために使う。 */
export function createModelLister(fetchImpl: FetchLike = fetch): ProviderModelLister {
  return async (request) => {
    const outcome = await probeModels(fetchImpl, request);
    if (outcome.status === "unsupported") {
      throw new ProviderRequestError(
        "provider_no_models",
        `${request.target?.url ?? ""} はモデル一覧（/models）を公開していません`,
      );
    }
    if (outcome.ids.length === 0) {
      throw new ProviderRequestError(
        "provider_no_models",
        `${request.target?.url ?? ""} に使えるモデルがありませんでした`,
      );
    }
    return outcome.ids;
  };
}

/** OpenAI 互換の応答（{ data: [{ id }] }）からモデル ID を取り出す。形が違えば null。 */
async function readModelIds(response: Response): Promise<string[] | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  if (typeof body !== "object" || body === null) return null;
  if (!Array.isArray((body as { data?: unknown }).data)) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of (body as { data: unknown[] }).data) {
    const id = readModelId(item);
    if (id === null || seen.has(id)) continue;

    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function readModelId(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;

  const id = (item as { id?: unknown }).id;
  return typeof id === "string" ? id.trim() : null;
}

/** プロバイダが返すエラーの本文から、画面に出せる 1 行を取り出す。 */
async function readFailureDetail(response: Response): Promise<string | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }

  if (text.trim().length === 0) return null;

  try {
    const body: unknown = JSON.parse(text);
    const message = readErrorMessage(body);
    if (message !== null) return message;
  } catch {
    // JSON でない本文は、そのまま短く添える。
  }

  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

function readErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;

  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }

  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

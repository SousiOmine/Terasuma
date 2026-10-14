import { findProviderCatalogEntry, type ProviderCatalogEntry } from "../shared/providers";
import type { ApiErrorCode } from "../shared/types";

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

/** どのプロバイダに、どの資格で接続するか。保存前の入力と保存済みの設定の両方から作る。 */
export type ProviderAccess = {
  /** カタログの id、または独自エンドポイントの id。 */
  id: string;
  apiKey: string | null;
  baseUrl: string | null;
};

/**
 * モデル一覧を取ってくる関数。
 * テストでは差し替える。取れなければ ProviderRequestError を投げる。
 */
export type ProviderModelLister = (access: ProviderAccess, signal?: AbortSignal) => Promise<string[]>;

/**
 * 一覧の取得に使う fetch の形。ここで使う引数だけに絞ってあるので、テストでは素の関数を渡せる。
 */
export type FetchLike = (
  input: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/** 応答が返らないまま待ち続けないための上限。 */
export const MODELS_TIMEOUT_MS = 20_000;

/**
 * プロバイダの /models を叩いて、使えるモデルの一覧を得る。
 *
 * ここは「設定が正しいか」を確かめる唯一の場所でもある。API キーが違えば 401 が返り、
 * 接続先が違えば到達できない。どちらも黙って通さず、理由を添えて失敗させる。
 */
export function createProviderModelLister(fetchImpl: FetchLike = fetch): ProviderModelLister {
  return async (access, signal) => {
    const entry = findProviderCatalogEntry(access.id);
    const request = buildModelsRequest(access, entry);

    const timeout = AbortSignal.timeout(MODELS_TIMEOUT_MS);
    const abort = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetchImpl(request.url, { headers: request.headers, signal: abort });
    } catch (error) {
      if (timeout.aborted) {
        throw new ProviderRequestError(
          "provider_unreachable",
          `${request.url} から ${MODELS_TIMEOUT_MS / 1000} 秒以内に応答がありません`,
        );
      }
      throw new ProviderRequestError("provider_unreachable", `${request.url} に接続できません: ${describe(error)}`);
    }

    if (!response.ok) {
      const detail = await readFailureDetail(response);
      if (response.status === 401 || response.status === 403) {
        throw new ProviderRequestError("provider_auth_failed", detail ?? `HTTP ${response.status}`);
      }
      throw new ProviderRequestError("provider_unreachable", `HTTP ${response.status}${detail === null ? "" : `: ${detail}`}`);
    }

    const ids = await readModelIds(response, entry);
    if (ids.length === 0) {
      throw new ProviderRequestError("provider_no_models", `${request.url} に使えるモデルがありませんでした`);
    }
    return ids;
  };
}

type ModelsRequest = {
  url: string;
  headers: Record<string, string>;
};

function buildModelsRequest(access: ProviderAccess, entry: ProviderCatalogEntry | undefined): ModelsRequest {
  const headers: Record<string, string> = { Accept: "application/json" };

  if (entry?.kind === "builtin") {
    if (access.apiKey === null) {
      // 設定の検証で必ず付く。ここに来るのは実装の誤りなので、黙って続けない。
      throw new Error(`プロバイダ ${access.id} の API キーがありません`);
    }
    if (entry.modelsAuth === "x-api-key") headers["x-api-key"] = access.apiKey;
    else headers["Authorization"] = `Bearer ${access.apiKey}`;

    return { url: entry.modelsUrl, headers: { ...headers, ...entry.modelsHeaders } };
  }

  // ここから先は OpenAI 互換のエンドポイント。一覧は <ベース URL>/models にあり、認証は Bearer。
  if (access.baseUrl === null) {
    throw new Error(`プロバイダ ${access.id} のベース URL がありません`);
  }
  if (access.apiKey !== null) headers["Authorization"] = `Bearer ${access.apiKey}`;

  return { url: `${access.baseUrl}/models`, headers };
}

/** OpenAI 互換の応答（{ data: [{ id }] }）からモデル ID を取り出す。 */
async function readModelIds(response: Response, entry: ProviderCatalogEntry | undefined): Promise<string[]> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ProviderRequestError(
      "provider_unreachable",
      `モデル一覧を JSON として読めません: ${describe(error)}`,
    );
  }

  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    throw new ProviderRequestError("provider_unreachable", "モデル一覧の形式が想定と違います（data 配列がありません）");
  }

  const prefix = entry?.kind === "builtin" ? entry.modelsIdPrefix : undefined;
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const item of (body as { data: unknown[] }).data) {
    const raw = readModelId(item);
    if (raw === null) continue;

    const id = prefix !== undefined && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (id.length === 0 || seen.has(id)) continue;

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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

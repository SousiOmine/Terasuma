/**
 * models.dev（https://models.dev）のカタログ。
 *
 * 設定画面に並べるプロバイダとモデルの一覧はここから取る。取得は 1 回だけ行い、
 * メモリとディスク（データディレクトリ）に持って、TTL を過ぎたら取り直す。
 * 応答は 5MB を超えるため、クライアントへは必要な範囲だけを API で返す。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getProviderConfig } from "@mastra/core/llm";
import { modelParts, type ModelId } from "../shared/model";
import type { FetchLike } from "./provider-models";
import { describeError } from "../shared/errors";

const MODELS_DEV_URL = "https://models.dev/api.json";
export const CATALOG_FILE_NAME = "models-dev.json";
/** カタログを取り直す間隔。 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** 取得が返らないまま待ち続けないための上限。 */
const CATALOG_TIMEOUT_MS = 30_000;

/** 思考強度としてモデルが受け付ける指定。models.dev の reasoning_options をそのまま持つ。 */
export type CatalogReasoningOption =
  | { type: "effort"; values: readonly string[] }
  | { type: "toggle" }
  | { type: "budget_tokens"; min: number | null; max: number | null };

export type CatalogModel = {
  id: string;
  /** 一度に扱える文脈の長さ（トークン）。models.dev が持たないモデルでは null。 */
  contextTokens: number | null;
  reasoningOptions: readonly CatalogReasoningOption[];
};

export type CatalogProvider = {
  id: string;
  name: string;
  /** models.dev が持つベース URL。無いものは Mastra のモデルルーターが既定の URL を使う。 */
  api: string | null;
};

export type CatalogSnapshot = {
  /** 取得した時刻（epoch ミリ秒）。 */
  fetchedAt: number;
  providers: readonly CatalogProvider[];
  /** プロバイダ id → モデル（id の昇順）。 */
  models: ReadonlyMap<string, readonly CatalogModel[]>;
};

export type Catalog = {
  /** 取得済みのカタログ。まだ読めていなければ null。 */
  snapshot(): CatalogSnapshot | null;
  /**
   * カタログを使える状態にして返す。
   * fresh を付けたときだけ TTL を見て取り直す（チャットの呼び出しで通信を待たせないため）。
   */
  load(options?: { fresh?: boolean }): Promise<CatalogSnapshot>;
};

/** ディスクに置く形。取得時刻を持たせて、TTL の判定に使う。 */
type CatalogFile = {
  fetchedAt: number;
  data: unknown;
};

/**
 * カタログを 1 から組み立てる。
 * 形が想定と違うものは読み飛ばす（models.dev 側の追加や欠けでアプリ全体を止めないため）。
 */
export function parseCatalog(raw: unknown, fetchedAt: number): CatalogSnapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("models.dev の応答がオブジェクトではありません");
  }

  const providers: CatalogProvider[] = [];
  const models = new Map<string, readonly CatalogModel[]>();

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const provider = readProvider(id, value);
    if (provider === null) continue;
    if (getProviderConfig(id) === undefined) continue;

    providers.push(provider);
    models.set(id, readModels(value));
  }

  providers.sort((left, right) => left.name.localeCompare(right.name));
  return { fetchedAt, providers, models };
}

/** カタログを読み書きする。ディスクの場所と fetch を差し替えられるようにしてある。 */
export function createCatalog(options: {
  /** ディスクのキャッシュの場所。 */
  cachePath: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  ttlMs?: number;
}): Catalog {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const cachePath = options.cachePath;

  let current: CatalogSnapshot | null = null;
  let loading: Promise<CatalogSnapshot> | null = null;

  function store(snapshot: CatalogSnapshot): CatalogSnapshot {
    current = snapshot;
    return snapshot;
  }

  function readFileCache(): CatalogSnapshot | null {
    let text: string;
    try {
      text = readFileSync(cachePath, "utf8");
    } catch {
      // キャッシュが無いのは通常の状態（初回起動）。
      return null;
    }

    try {
      const file = JSON.parse(text) as CatalogFile;
      if (typeof file !== "object" || file === null || typeof file.fetchedAt !== "number") return null;
      return parseCatalog(file.data, file.fetchedAt);
    } catch {
      // 壊れたキャッシュは捨てて取り直す。ここで止めると起動できなくなる。
      return null;
    }
  }

  function writeFileCache(data: unknown, fetchedAt: number): void {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, `${JSON.stringify({ fetchedAt, data } satisfies CatalogFile)}\n`, "utf8");
    } catch {
      // 書けなくてもメモリのカタログで動く。次回の起動で取り直すだけ。
    }
  }

  async function fetchCatalog(): Promise<CatalogSnapshot> {
    const abort = AbortSignal.timeout(CATALOG_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(MODELS_DEV_URL, { headers: { Accept: "application/json" }, signal: abort });
    } catch (error) {
      throw new Error(`${MODELS_DEV_URL} からカタログを取得できません: ${describeError(error)}`, { cause: error });
    }

    if (!response.ok) {
      throw new Error(`${MODELS_DEV_URL} からカタログを取得できません: HTTP ${response.status}`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new Error(`${MODELS_DEV_URL} の応答を JSON として読めません: ${describeError(error)}`, { cause: error });
    }

    const fetchedAt = now();
    const snapshot = parseCatalog(raw, fetchedAt);
    writeFileCache(raw, fetchedAt);
    return store(snapshot);
  }

  return {
    snapshot() {
      return current;
    },

    async load(options = {}) {
      const fresh = options.fresh === true;

      if (current !== null && (!fresh || now() - current.fetchedAt < ttlMs)) return current;

      // 取得は 1 本にまとめる。設定画面を開いた直後に複数の API が来ても取得は 1 回で済む。
      if (loading === null) {
        loading = (async () => {
          if (current === null) {
            const cached = readFileCache();
            if (cached !== null) {
              // ディスクのカタログでも動かせるようにしておく（models.dev に届かないときの逃げ道）。
              if (!fresh || now() - cached.fetchedAt < ttlMs) return store(cached);
            }
          }

          try {
            return await fetchCatalog();
          } catch (error) {
            if (current !== null) return current;
            const cached = readFileCache();
            if (cached !== null) return store(cached);
            throw error;
          }
        })().finally(() => {
          loading = null;
        });
      }

      return await loading;
    },
  };
}

function readProvider(id: string, value: unknown): CatalogProvider | null {
  if (typeof value !== "object" || value === null) return null;

  const source = value as Record<string, unknown>;
  if (typeof source["models"] !== "object" || source["models"] === null) return null;

  return {
    id,
    name: readText(source, "name") ?? id,
    api: readText(source, "api"),
  };
}

function readModels(provider: unknown): readonly CatalogModel[] {
  const source = (provider as Record<string, unknown>)["models"];
  if (typeof source !== "object" || source === null) return [];

  const models: CatalogModel[] = [];
  for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;

    const entry = value as Record<string, unknown>;
    // 非推奨のモデルは選ばせない。使えなくなったものを一覧に混ぜると、選んだ後に失敗する。
    if (readText(entry, "status") === "deprecated") continue;

    models.push({
      id,
      contextTokens: readContextTokens(entry["limit"]),
      reasoningOptions: readReasoningOptions(entry["reasoning_options"]),
    });
  }

  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}

function readReasoningOptions(raw: unknown): readonly CatalogReasoningOption[] {
  if (!Array.isArray(raw)) return [];

  const options: CatalogReasoningOption[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;

    const entry = item as Record<string, unknown>;
    if (entry["type"] === "toggle") {
      options.push({ type: "toggle" });
      continue;
    }
    if (entry["type"] === "effort") {
      const values = readTextList(entry["values"]);
      if (values.length > 0) options.push({ type: "effort", values });
      continue;
    }
    if (entry["type"] === "budget_tokens") {
      options.push({ type: "budget_tokens", min: readNumber(entry["min"]), max: readNumber(entry["max"]) });
    }
  }
  return options;
}

/** モデルが持つ思考強度の選択肢。effort 以外（toggle や budget_tokens）は今回扱わない。 */
export function effortValues(model: CatalogModel | null): readonly string[] {
  if (model === null) return [];

  for (const option of model.reasoningOptions) {
    if (option.type === "effort") return option.values;
  }
  return [];
}

/**
 * 既定のモデルの文脈長（トークン）。カタログから分からなければ null。
 * 分からないモデル（接続先を自分で決めたものなど）の扱いは、呼ぶ側が決める。
 */
export function modelContextTokens(snapshot: CatalogSnapshot | null, model: ModelId | null): number | null {
  if (snapshot === null || model === null) return null;

  const { provider, model: name } = modelParts(model);
  const entry = snapshot.models.get(provider)?.find((candidate) => candidate.id === name);
  return entry?.contextTokens ?? null;
}

/** models.dev の limit.context。正の数でなければ「分からない」として null にする。 */
function readContextTokens(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;

  const value = (raw as Record<string, unknown>)["context"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function readText(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length > 0) items.push(trimmed);
  }
  return items;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}


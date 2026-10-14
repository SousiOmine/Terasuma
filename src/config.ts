import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAppPaths } from "./paths";
import { isModelId, type ModelId } from "./shared/model";
import { findProviderCatalogEntry } from "./shared/providers";
import type { ProviderCredentials } from "./shared/types";

/** 使う LLM 実装。mock は開発・テスト専用で、既定には決してならない。 */
export type EngineKind = "mastra" | "mock";

/**
 * プロバイダ 1 件の設定。
 * 既知のプロバイダは apiKey だけを持ち、OpenAI 互換の独自エンドポイントは baseUrl（と label）も持つ。
 * baseUrl があるかどうかが「独自エンドポイントかどうか」の印になる。
 */
export type ProviderSettings = {
  apiKey?: string;
  baseUrl?: string;
  label?: string;
};

/** プロバイダ id → 設定。並び順は設定ファイルに書かれた順のまま保つ。 */
export type ProvidersSettings = Record<string, ProviderSettings>;

/** プロバイダ 1 件に書ける項目。 */
const PROVIDER_KEYS = ["apiKey", "baseUrl", "label"] as const;

const FILE_KEYS = ["model", "providers", "port", "engine"] as const;
type FileKey = (typeof FILE_KEYS)[number];

/** config.json に書ける設定。書かなかった項目は既定値になる。 */
export type FileSettings = Partial<{
  model: ModelId;
  providers: ProvidersSettings;
  port: number;
  engine: EngineKind;
}>;

/** 実行時に使うモデル設定。config.json のうち、設定画面から変えられる部分。 */
export type ModelSettings = {
  /** 既定のモデル。未設定なら null。 */
  model: ModelId | null;
  providers: ProvidersSettings;
};

export type AppConfig = {
  host: string;
  port: number;
  /** 設定ファイルを置くディレクトリ。 */
  configDir: string;
  /** 設定ファイルの絶対パス。無ければ既定値で動く。 */
  configPath: string;
  /** 会話データを置くディレクトリ。 */
  dataDir: string;
  /** SQLite の DB ファイル。 */
  dbPath: string;
  engine: EngineKind;
  isDevelopment: boolean;
};

export const DEFAULT_PORT = 3000;
export const CONFIG_FILE_NAME = "config.json";

/**
 * 今回は localhost のみに公開する。
 * LAN / Tailscale への公開とトークン認証は次のマイルストーンで実装する予定。
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** プロバイダ id に使える文字。モデル ID の先頭部分になるため、スラッシュと空白は許さない。 */
export function isProviderId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

/**
 * サーバ全体の設定は「環境変数 → config.json → 既定値」の順に強い方を採用する。
 * 環境変数はその場限りの上書きとして使えるようにしてある。
 *
 * モデルとプロバイダは設定画面から書き換えるため、ここでは返さない（settings.ts が持つ）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaults = resolveAppPaths(env);
  const configDir = env.TERASUMA_CONFIG_DIR?.trim() || defaults.configDir;
  const dataDir = env.TERASUMA_DATA_DIR?.trim() || defaults.dataDir;
  const configPath = join(configDir, CONFIG_FILE_NAME);

  // 読むだけでなく検証もする。壊れた設定のまま起動しないよう、起動時に一度ここを通す。
  const file = readSettingsFile(configPath);

  return {
    host: LOOPBACK_HOST,
    port: readEnvPort(env) ?? file.port ?? DEFAULT_PORT,
    configDir,
    configPath,
    dataDir,
    dbPath: join(dataDir, "terasuma.db"),
    engine: readEnvEngine(env) ?? file.engine ?? "mastra",
    isDevelopment: env.NODE_ENV !== "production",
  };
}

/** 設定とデータのディレクトリを用意する。起動時に一度だけ呼ぶ。 */
export function ensureDirectories(config: AppConfig): void {
  mkdirSync(config.configDir, { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });
}

/** 設定ファイルから、実行時に使うモデル設定だけを取り出す。 */
export function toModelSettings(file: FileSettings): ModelSettings {
  return { model: file.model ?? null, providers: file.providers ?? {} };
}

/** 設定ファイルがまだ無ければ空を返す。あるのに読めない場合は起動を止める。 */
export function readSettingsFile(path: string): FileSettings {
  if (!existsSync(path)) return {};

  const text = readFileSync(path, "utf8");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} を JSON として解釈できません: ${describe(error)}`, { cause: error });
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} の内容は JSON のオブジェクトにしてください`);
  }

  const source = raw as Record<string, unknown>;

  // 綴り違いに気づかないまま動くと、設定したつもりで効かない状態になる。
  const unknownKeys = Object.keys(source).filter((key) => !FILE_KEYS.includes(key as FileKey));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${path} に未知の項目があります: ${unknownKeys.join(", ")}（使える項目: ${FILE_KEYS.join(", ")}）`,
    );
  }

  const settings: FileSettings = {};

  const model = readString(source, "model", path);
  if (model !== undefined) {
    if (!isModelId(model)) {
      throw new Error(`${path} の model は "provider/model" の形式にしてください（現在の値: ${JSON.stringify(model)}）`);
    }
    settings.model = model;
  }

  const providers = readProviders(source, path);
  if (providers !== undefined) settings.providers = providers;

  const port = readNumber(source, "port", path);
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${path} の port は 1 から 65535 の整数にしてください（現在の値: ${port}）`);
    }
    settings.port = port;
  }

  const engine = readString(source, "engine", path);
  if (engine !== undefined) {
    if (engine !== "mastra" && engine !== "mock") {
      throw new Error(`${path} の engine は "mastra" か "mock" にしてください（現在の値: ${JSON.stringify(engine)}）`);
    }
    settings.engine = engine;
  }

  return settings;
}

/**
 * 設定ファイルを書き換える。設定画面からの変更と、手で編集した内容の取り込みに使う。
 * 書き込みの途中で落ちても元のファイルが壊れないよう、一時ファイル経由で置き換える。
 */
export function writeSettingsFile(path: string, settings: FileSettings): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, serialize(settings), "utf8");
  renameSync(temporary, path);
}

/** 設定ファイルに書く文字列。項目の並びは常に同じにして、差分を読みやすくする。 */
function serialize(settings: FileSettings): string {
  const ordered: Record<string, unknown> = {};
  if (settings.model !== undefined) ordered["model"] = settings.model;
  if (settings.providers !== undefined) ordered["providers"] = settings.providers;
  if (settings.port !== undefined) ordered["port"] = settings.port;
  if (settings.engine !== undefined) ordered["engine"] = settings.engine;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * プロバイダ 1 件の設定を検証し、保存できる形に整える。
 *
 * 既知のプロバイダはモデルルーターに任せるので baseUrl を持たない。
 * 独自エンドポイントは baseUrl が無いと接続先が決まらないため、必ず要求する。
 * 既定値で埋め合わせると「設定したつもりで繋がらない」状態になるので、ここでは何も補わない。
 */
export function normalizeProvider(id: string, raw: ProviderSettings, source: string): ProviderSettings {
  const entry = findProviderCatalogEntry(id);
  const isEndpoint = entry === undefined || entry.kind === "openai-compatible";

  if (isEndpoint && raw.baseUrl === undefined) {
    throw new Error(`${source} に baseUrl を指定してください（OpenAI 互換のエンドポイントが必要です）`);
  }
  if (!isEndpoint && raw.baseUrl !== undefined) {
    throw new Error(`${source} の baseUrl は OpenAI 互換のエンドポイントにだけ指定できます`);
  }

  if (entry?.kind === "builtin" && raw.apiKey === undefined) {
    throw new Error(`${source} に apiKey を指定してください`);
  }

  const labelAllowed = entry === undefined || (entry.kind === "openai-compatible" && entry.requiresLabel);
  if (raw.label !== undefined && !labelAllowed) {
    throw new Error(`${source} の label は名前を付けて保存するエンドポイントにだけ指定できます`);
  }

  const settings: ProviderSettings = {};
  if (raw.apiKey !== undefined) settings.apiKey = raw.apiKey;
  if (raw.baseUrl !== undefined) settings.baseUrl = normalizeBaseUrl(raw.baseUrl, source);
  if (raw.label !== undefined) settings.label = raw.label;
  return settings;
}

/** API から来た入力（未入力は null）を、設定ファイルに書ける形へ直す。 */
export function providerSettingsFromForm(form: ProviderCredentials): ProviderSettings {
  const settings: ProviderSettings = {};

  const apiKey = form.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length > 0) settings.apiKey = apiKey;

  const baseUrl = form.baseUrl?.trim();
  if (baseUrl !== undefined && baseUrl.length > 0) settings.baseUrl = baseUrl;

  const label = form.label?.trim();
  if (label !== undefined && label.length > 0) settings.label = label;

  return settings;
}

/** エンドポイントの指定。末尾のスラッシュは落として、URL の組み立てを単純にする。 */
function normalizeBaseUrl(value: string, source: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(`${source} の baseUrl は URL として読めません（現在の値: ${JSON.stringify(value)}）`, {
      cause: error,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${source} の baseUrl は http:// か https:// で始めてください（現在の値: ${JSON.stringify(value)}）`);
  }
  return trimmed;
}

function readProviders(source: Record<string, unknown>, path: string): ProvidersSettings | undefined {
  const value = source["providers"];
  if (value === undefined) return undefined;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} の providers はオブジェクトにしてください`);
  }

  const providers: ProvidersSettings = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isProviderId(id)) {
      throw new Error(
        `${path} の providers に使えない id があります: ${JSON.stringify(id)}（英小文字・数字・ハイフンで指定してください）`,
      );
    }
    providers[id] = readProviderEntry(id, entry, path);
  }
  return providers;
}

function readProviderEntry(id: string, raw: unknown, path: string): ProviderSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} の providers.${id} はオブジェクトにしてください`);
  }

  const source = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(source).filter((key) => !PROVIDER_KEYS.includes(key as (typeof PROVIDER_KEYS)[number]));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${path} の providers.${id} に未知の項目があります: ${unknownKeys.join(", ")}（使える項目: ${PROVIDER_KEYS.join(", ")}）`,
    );
  }

  return normalizeProvider(
    id,
    {
      apiKey: readProviderString(source, "apiKey", id, path),
      baseUrl: readProviderString(source, "baseUrl", id, path),
      label: readProviderString(source, "label", id, path),
    },
    `${path} の providers.${id}`,
  );
}

function readProviderString(
  source: Record<string, unknown>,
  key: (typeof PROVIDER_KEYS)[number],
  id: string,
  path: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${path} の providers.${id}.${key} は文字列で指定してください`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${path} の providers.${id}.${key} を空にはできません`);
  }
  return trimmed;
}

function readString(source: Record<string, unknown>, key: FileKey, path: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} の ${key} は文字列で指定してください`);

  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${path} の ${key} を空にはできません`);
  return trimmed;
}

function readNumber(source: Record<string, unknown>, key: FileKey, path: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`${path} の ${key} は数値で指定してください`);
  return value;
}

function readEnvPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.TERASUMA_PORT?.trim();
  if (raw === undefined || raw.length === 0) return undefined;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`TERASUMA_PORT は 1 から 65535 の整数で指定してください（現在の値: ${JSON.stringify(raw)}）`);
  }
  return port;
}

function readEnvEngine(env: NodeJS.ProcessEnv): EngineKind | undefined {
  const raw = env.TERASUMA_ENGINE?.trim();
  if (raw === undefined || raw.length === 0) return undefined;

  if (raw !== "mastra" && raw !== "mock") {
    throw new Error(`TERASUMA_ENGINE は "mastra" か "mock" で指定してください（現在の値: ${JSON.stringify(raw)}）`);
  }
  return raw;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

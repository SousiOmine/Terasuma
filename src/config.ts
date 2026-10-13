import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAppPaths } from "./paths";

/** 使う LLM 実装。mock は開発・テスト専用で、既定には決してならない。 */
export type EngineKind = "mastra" | "mock";

/** Mastra のモデルルーター形式。先頭のセグメントがプロバイダ名であればよい。 */
export type ModelId = `${string}/${string}`;

const FILE_KEYS = ["model", "baseUrl", "apiKey", "port", "engine"] as const;
type FileKey = (typeof FILE_KEYS)[number];

/** config.json に書ける設定。書かなかった項目は既定値になる。 */
export type FileSettings = Partial<{
  model: ModelId;
  baseUrl: string;
  apiKey: string;
  port: number;
  engine: EngineKind;
}>;

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
  model: ModelId;
  /** OpenAI 互換の独自エンドポイントを使う場合のみ設定する。 */
  baseUrl: string | null;
  apiKey: string | null;
  engine: EngineKind;
  isDevelopment: boolean;
};

export const DEFAULT_PORT = 3000;
export const DEFAULT_MODEL: ModelId = "deepseek/deepseek-flash";
export const CONFIG_FILE_NAME = "config.json";

/**
 * 今回は localhost のみに公開する。
 * LAN / Tailscale への公開とトークン認証は次のマイルストーンで実装する予定。
 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * "provider/model" の形かどうかを判定する。
 * プロバイダ名の後にさらにスラッシュが続く形（openrouter/anthropic/...）も許す。
 */
export function isModelId(value: string): value is ModelId {
  return /^[^/\s]+\/.+$/.test(value);
}

/**
 * 設定は「環境変数 → config.json → 既定値」の順に強い方を採用する。
 * 環境変数はその場限りの上書きとして使えるようにしてある。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaults = resolveAppPaths(env);
  const configDir = env.TERASUMA_CONFIG_DIR?.trim() || defaults.configDir;
  const dataDir = env.TERASUMA_DATA_DIR?.trim() || defaults.dataDir;
  const configPath = join(configDir, CONFIG_FILE_NAME);

  const file = readSettingsFile(configPath);

  const envModel = env.TERASUMA_MODEL?.trim();
  if (envModel !== undefined && !isModelId(envModel)) {
    throw new Error(
      `TERASUMA_MODEL は "provider/model" の形式で指定してください（現在の値: ${JSON.stringify(envModel)}）`,
    );
  }

  return {
    host: LOOPBACK_HOST,
    port: readEnvPort(env) ?? file.port ?? DEFAULT_PORT,
    configDir,
    configPath,
    dataDir,
    dbPath: join(dataDir, "terasuma.db"),
    model: envModel || file.model || DEFAULT_MODEL,
    baseUrl: env.TERASUMA_BASE_URL?.trim() || file.baseUrl || null,
    apiKey: env.TERASUMA_API_KEY?.trim() || file.apiKey || null,
    engine: readEnvEngine(env) ?? file.engine ?? "mastra",
    isDevelopment: env.NODE_ENV !== "production",
  };
}

/** 設定とデータのディレクトリを用意する。起動時に一度だけ呼ぶ。 */
export function ensureDirectories(config: AppConfig): void {
  mkdirSync(config.configDir, { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });
}

/** 設定ファイルがまだ無ければ空を返す。あるのに読めない場合は起動を止める。 */
function readSettingsFile(path: string): FileSettings {
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

  const baseUrl = readString(source, "baseUrl", path);
  if (baseUrl !== undefined) settings.baseUrl = baseUrl;

  const apiKey = readString(source, "apiKey", path);
  if (apiKey !== undefined) settings.apiKey = apiKey;

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

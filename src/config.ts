import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 使う LLM 実装。mock は開発・テスト専用で、既定には決してならない。 */
export type EngineKind = "mastra" | "mock";

/** Mastra のモデルルーター形式。先頭のセグメントがプロバイダ名であればよい。 */
export type ModelId = `${string}/${string}`;

/**
 * "provider/model" の形かどうかを判定する。
 * プロバイダ名の後にさらにスラッシュが続く形（openrouter/anthropic/...）も許す。
 */
export function isModelId(value: string): value is ModelId {
  return /^[^/\s]+\/.+$/.test(value);
}

export type AppConfig = {
  host: string;
  port: number;
  dataDir: string;
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

/**
 * 今回は localhost のみに公開する。
 * LAN / Tailscale への公開とトークン認証は次のマイルストーンで実装する予定。
 */
export const LOOPBACK_HOST = "127.0.0.1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.TERASUMA_DATA_DIR?.trim() || join(homedir(), ".terasuma");
  const port = Number.parseInt(env.TERASUMA_PORT ?? "", 10);
  const model = env.TERASUMA_MODEL?.trim() || DEFAULT_MODEL;

  // 設定ミスは起動時にエラーにする。気づかないうちに既定値へ切り替えると、
  // 意図しないモデルで課金されることがある。
  if (!isModelId(model)) {
    throw new Error(
      `TERASUMA_MODEL は "provider/model" の形式で指定してください（現在の値: ${JSON.stringify(model)}）`,
    );
  }

  return {
    host: LOOPBACK_HOST,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    dataDir,
    dbPath: join(dataDir, "terasuma.db"),
    model,
    baseUrl: env.TERASUMA_BASE_URL?.trim() || null,
    apiKey: env.TERASUMA_API_KEY?.trim() || null,
    engine: env.TERASUMA_ENGINE === "mock" ? "mock" : "mastra",
    isDevelopment: env.NODE_ENV !== "production",
  };
}

/** データディレクトリを用意する。起動時に一度だけ呼ぶ。 */
export function ensureDataDir(config: AppConfig): void {
  mkdirSync(config.dataDir, { recursive: true });
}

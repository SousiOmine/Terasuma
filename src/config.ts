import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveAppPaths } from "./paths";
import { readSettingsFile, type EngineKind } from "./server/data/settings-schema";

/**
 * 起動に使う設定。設定ファイル（config.json）の読み取りはサーバ側の
 * data/settings-schema.ts が受け持つ。ここには「どのディレクトリで、どのポートで、
 * どの実装で動くか」だけを置く。
 */

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

/**
 * サーバ全体の設定は「環境変数 → config.json → 既定値」の順に強い方を採用する。
 * 環境変数はその場限りの上書きとして使えるようにしてある。
 *
 * モデルとプロバイダは設定画面から書き換えるため、ここでは返さない（SettingsStore が持つ）。
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
    engine: readEnvEngine(env) ?? file.engine ?? "ai-sdk",
    isDevelopment: env.NODE_ENV !== "production",
  };
}

/** 設定とデータのディレクトリを用意する。起動時に一度だけ呼ぶ。 */
export function ensureDirectories(config: AppConfig): void {
  mkdirSync(config.configDir, { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });
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

  if (raw !== "ai-sdk" && raw !== "mock") {
    throw new Error(`TERASUMA_ENGINE は "ai-sdk" か "mock" で指定してください（現在の値: ${JSON.stringify(raw)}）`);
  }
  return raw;
}

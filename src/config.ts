import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProviderConfig } from "@mastra/core/llm";
import { resolveAppPaths } from "./paths";
import { isModelId, type ModelId } from "./shared/model";
import type { McpServerForm, ProviderCredentials } from "./shared/types";
import { describeError } from "./shared/errors";

/** 使う LLM 実装。mock は開発・テスト専用で、既定には決してならない。 */
type EngineKind = "mastra" | "mock";

/**
 * プロバイダ 1 件の設定。
 * カタログのプロバイダは apiKey だけを持ち、OpenAI 互換の独自エンドポイントは baseUrl（と label）も持つ。
 * baseUrl があるかどうかが「独自エンドポイントかどうか」の印になる。
 */
export type ProviderSettings = {
  apiKey?: string;
  baseUrl?: string;
  label?: string;
};

/** モデル 1 件ごとの設定。 */
export type ModelOptionSettings = {
  /** 思考強度。未設定なら渡さない（プロバイダの既定に任せる）。 */
  reasoningEffort?: string;
};

/** モデル id → 設定。並び順は設定ファイルに書かれた順のまま保つ。 */
type ModelOptionsSettings = Record<string, ModelOptionSettings>;

/** プロバイダ id → 設定。並び順は設定ファイルに書かれた順のまま保つ。 */
export type ProvidersSettings = Record<string, ProviderSettings>;

/** この端末で動かす MCP サーバー（stdio）。コマンドを起動して標準入出力で話す。 */
export type McpStdioServerSettings = {
  type: "stdio";
  /** 起動するコマンド。PATH が通った名前か、実行ファイルの絶対パス。 */
  command: string;
  args?: string[];
  /** 子プロセスに足す環境変数。 */
  env?: Record<string, string>;
};

/**
 * HTTP で話す MCP サーバー。
 * OAuth が要るかどうかは設定に書かない（サーバーが認可を求めたときに始める）。
 */
export type McpHttpServerSettings = {
  type: "http";
  url: string;
};

/**
 * MCP サーバー 1 件の設定。
 * type を明示させ、command と url のどちらがあるかで種類を推測しない
 * （取り違えると起動時に分かりにくい失敗になるため）。
 */
export type McpServerSettings = McpStdioServerSettings | McpHttpServerSettings;

/** MCP サーバー id → 設定。並び順は設定ファイルに書かれた順のまま保つ。 */
export type McpServersSettings = Record<string, McpServerSettings>;

/** MCP サーバー 1 件に書ける項目。 */
const MCP_SERVER_KEYS = ["type", "command", "args", "env", "url"] as const;

/** プロバイダ 1 件に書ける項目。 */
const PROVIDER_KEYS = ["apiKey", "baseUrl", "label"] as const;

/** モデル 1 件に書ける項目。 */
const MODEL_OPTION_KEYS = ["reasoningEffort"] as const;

const FILE_KEYS = ["model", "providers", "modelOptions", "mcpServers", "port", "engine"] as const;
type FileKey = (typeof FILE_KEYS)[number];

/** config.json に書ける設定。書かなかった項目は既定値になる。 */
export type FileSettings = Partial<{
  model: ModelId;
  providers: ProvidersSettings;
  modelOptions: ModelOptionsSettings;
  mcpServers: McpServersSettings;
  port: number;
  engine: EngineKind;
}>;

/** 実行時に使う MCP の設定。 */
export type McpSettings = {
  servers: McpServersSettings;
};

/** 実行時に使うモデル設定。config.json のうち、設定画面から変えられる部分。 */
export type ModelSettings = {
  /** 既定のモデル。未設定なら null。 */
  model: ModelId | null;
  providers: ProvidersSettings;
  /** モデルごとの設定（思考強度など）。 */
  modelOptions: ModelOptionsSettings;
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

/** id に使える文字。AI へ渡す名前の先頭部分になるため、記号と空白は許さない。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * MCP サーバーの id に使えない名前。
 * ツール名は "<サーバー id>_<ツール名>" になるので、コンテナの内蔵ツール
 * （"computer_..."）と同じ名前が作れてしまう。同じ名前になると、どちらのツールか
 * モデルにも画面にも区別が付かないので、ここで止める。
 */
const RESERVED_MCP_SERVER_IDS: readonly string[] = ["computer"];

/** プロバイダ id に使える文字。モデル ID の先頭部分になるため、スラッシュと空白は許さない。 */
export function isProviderId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** MCP サーバー id を受け付けられない理由。使える場合は null。 */
export function mcpServerIdProblem(value: string): string | null {
  if (RESERVED_MCP_SERVER_IDS.includes(value)) {
    return `${JSON.stringify(value)} は Terasuma の内蔵ツール（${RESERVED_MCP_SERVER_IDS.map((id) => `${id}_...`).join(", ")}）と同じ名前になるため使えません`;
  }
  if (!ID_PATTERN.test(value)) {
    return `${JSON.stringify(value)} は英小文字・数字・ハイフンで指定してください`;
  }
  return null;
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
  return {
    model: file.model ?? null,
    providers: file.providers ?? {},
    modelOptions: file.modelOptions ?? {},
  };
}

/** 設定ファイルから、実行時に使う MCP の設定だけを取り出す。 */
export function toMcpSettings(file: FileSettings): McpSettings {
  return { servers: file.mcpServers ?? {} };
}

/** 設定ファイルがまだ無ければ空を返す。あるのに読めない場合は起動を止める。 */
export function readSettingsFile(path: string): FileSettings {
  if (!existsSync(path)) return {};

  const text = readFileSync(path, "utf8");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} を JSON として解釈できません: ${describeError(error)}`, { cause: error });
  }

  if (!isRecord(raw)) {
    throw new Error(`${path} の内容は JSON のオブジェクトにしてください`);
  }

  // 綴り違いに気づかないまま動くと、設定したつもりで効かない状態になる。
  assertKnownKeys(raw, FILE_KEYS, path);
  const source = raw;

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

  const modelOptions = readModelOptions(source, path);
  if (modelOptions !== undefined) settings.modelOptions = modelOptions;

  const mcpServers = readMcpServers(source, path);
  if (mcpServers !== undefined) settings.mcpServers = mcpServers;

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
  if (settings.modelOptions !== undefined) ordered["modelOptions"] = settings.modelOptions;
  if (settings.mcpServers !== undefined) ordered["mcpServers"] = settings.mcpServers;
  if (settings.port !== undefined) ordered["port"] = settings.port;
  if (settings.engine !== undefined) ordered["engine"] = settings.engine;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * プロバイダ 1 件の設定を検証し、保存できる形に整える。
 *
 * baseUrl を持つものは OpenAI 互換の独自エンドポイントで、接続先を利用者が決める。
 * 持たないものは models.dev のカタログのプロバイダとして扱い、Mastra が URL を解決できることを確かめる。
 * 既定値で埋め合わせると「設定したつもりで繋がらない」状態になるので、ここでは何も補わない。
 */
export function normalizeProvider(id: string, raw: ProviderSettings, source: string): ProviderSettings {
  const isEndpoint = raw.baseUrl !== undefined;
  const registered = getProviderConfig(id) !== undefined;

  if (!isEndpoint && !registered) {
    throw new Error(
      `${source} に baseUrl を指定してください（${id} は models.dev のカタログに無いため、独自の接続先が必要です）`,
    );
  }
  if (!isEndpoint && raw.apiKey === undefined) {
    throw new Error(`${source} に apiKey を指定してください`);
  }
  if (raw.label !== undefined && !isEndpoint) {
    throw new Error(`${source} の label は OpenAI 互換のエンドポイントにだけ指定できます`);
  }

  const settings: ProviderSettings = {};
  if (raw.apiKey !== undefined) settings.apiKey = raw.apiKey;
  if (raw.baseUrl !== undefined) settings.baseUrl = normalizeHttpUrl(raw.baseUrl, source, "baseUrl");
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

/**
 * 画面から来た MCP サーバーの入力（未入力は null）を、設定に書ける形へ直す。
 * 種類と食い違う項目は黙って捨てずに失敗させる（入れたつもりで効かない状態を作らないため）。
 */
export function mcpServerSettingsFromForm(form: McpServerForm, source: string): McpServerSettings {
  // id の検証は、設定ファイルを読むときと同じ 1 つの規則に任せる。
  const idProblem = mcpServerIdProblem(form.id);
  if (idProblem !== null) {
    throw new Error(`${source} の id に使えない値です: ${idProblem}`);
  }

  if (form.type === "stdio") {
    if (form.url !== null) {
      throw new Error(`${source} の url は http のサーバーにだけ指定できます`);
    }

    return readMcpServerEntry(
      form.id,
      {
        type: "stdio",
        command: form.command ?? undefined,
        args: form.args === null ? undefined : [...form.args],
        env: form.env === null ? undefined : { ...form.env },
      },
      source,
    );
  }

  if (form.command !== null || form.args !== null || form.env !== null) {
    throw new Error(`${source} の command / args / env は stdio のサーバーにだけ指定できます`);
  }

  return readMcpServerEntry(form.id, { type: "http", url: form.url ?? undefined }, source);
}

/**
 * 接続先の URL を検証する。末尾のスラッシュは落として、URL の組み立てを単純にする。
 * プロバイダの baseUrl も MCP サーバーの url も指す先は 1 つなので、同じ扱いにする。
 */
function normalizeHttpUrl(value: string, source: string, what: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(`${source} の ${what} は URL として読めません（現在の値: ${JSON.stringify(value)}）`, {
      cause: error,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${source} の ${what} は http:// か https:// で始めてください（現在の値: ${JSON.stringify(value)}）`);
  }
  return trimmed;
}

/** オブジェクトとして読める値かどうか。配列は含めない。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 使える項目だけが書かれているか確かめる。綴り違いは起動時に落とす。 */
function assertKnownKeys(source: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknownKeys = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${where} に未知の項目があります: ${unknownKeys.join(", ")}（使える項目: ${allowed.join(", ")}）`);
  }
}

function readProviders(source: Record<string, unknown>, path: string): ProvidersSettings | undefined {
  const value = source["providers"];
  if (value === undefined) return undefined;

  if (!isRecord(value)) {
    throw new Error(`${path} の providers はオブジェクトにしてください`);
  }

  const providers: ProvidersSettings = {};
  for (const [id, entry] of Object.entries(value)) {
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
  if (!isRecord(raw)) {
    throw new Error(`${path} の providers.${id} はオブジェクトにしてください`);
  }

  assertKnownKeys(raw, PROVIDER_KEYS, `${path} の providers.${id}`);
  const source = raw;

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

/** MCP サーバーの一覧を読む。id は保存された並び順のまま保つ。 */
function readMcpServers(source: Record<string, unknown>, path: string): McpServersSettings | undefined {
  const value = source["mcpServers"];
  if (value === undefined) return undefined;

  if (!isRecord(value)) {
    throw new Error(`${path} の mcpServers はオブジェクトにしてください`);
  }

  const servers: McpServersSettings = {};
  for (const [id, entry] of Object.entries(value)) {
    const problem = mcpServerIdProblem(id);
    if (problem !== null) {
      throw new Error(`${path} の mcpServers に使えない id があります: ${problem}`);
    }
    servers[id] = readMcpServerEntry(id, entry, path);
  }
  return servers;
}

/**
 * MCP サーバー 1 件を読む。
 * type の取り違えは起動時に落とす（command を url として繋ぎに行くような失敗を作らない）。
 */
function readMcpServerEntry(id: string, raw: unknown, path: string): McpServerSettings {
  const where = `${path} の mcpServers.${id}`;
  if (!isRecord(raw)) {
    throw new Error(`${where} はオブジェクトにしてください`);
  }

  assertKnownKeys(raw, MCP_SERVER_KEYS, where);
  const source = raw;

  const type = source["type"];
  if (type === "stdio") return readStdioServer(source, where);
  if (type === "http") return readHttpServer(source, where);

  throw new Error(
    `${where} の type は "stdio" か "http" にしてください（現在の値: ${JSON.stringify(type)}）`,
  );
}

function readStdioServer(source: Record<string, unknown>, where: string): McpStdioServerSettings {
  if (source["url"] !== undefined) {
    throw new Error(`${where} の url は http のサーバーにだけ指定できます`);
  }

  const command = source["command"];
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(`${where} の command は空でない文字列にしてください`);
  }

  const settings: McpStdioServerSettings = { type: "stdio", command: command.trim() };

  const args = source["args"];
  if (args !== undefined) {
    if (!Array.isArray(args)) throw new Error(`${where} の args は配列にしてください`);

    // 空の配列は書かない（既定と同じ意味なので、設定ファイルに残す意味がない）。
    const values = args.map((arg, index) => {
      if (typeof arg !== "string" || arg.length === 0) {
        throw new Error(`${where} の args[${index}] は空でない文字列にしてください`);
      }
      return arg;
    });
    if (values.length > 0) settings.args = values;
  }

  const env = source["env"];
  if (env !== undefined) {
    if (!isRecord(env)) {
      throw new Error(`${where} の env はオブジェクトにしてください`);
    }

    const variables: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      // 環境変数名として読めない名前は、渡しても効かないまま気づけないのでここで止める。
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`${where} の env に環境変数名として使えない名前があります: ${JSON.stringify(name)}`);
      }
      if (typeof value !== "string") {
        throw new Error(`${where} の env.${name} は文字列にしてください`);
      }
      variables[name] = value;
    }
    if (Object.keys(variables).length > 0) settings.env = variables;
  }

  return settings;
}

function readHttpServer(source: Record<string, unknown>, where: string): McpHttpServerSettings {
  for (const key of ["command", "args", "env"] as const) {
    if (source[key] !== undefined) {
      throw new Error(`${where} の ${key} は stdio のサーバーにだけ指定できます`);
    }
  }

  const url = source["url"];
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error(`${where} の url は空でない文字列にしてください`);
  }

  return { type: "http", url: normalizeHttpUrl(url, where, "url") };
}

/** モデルごとの設定（思考強度など）を読む。 */
function readModelOptions(source: Record<string, unknown>, path: string): ModelOptionsSettings | undefined {
  const value = source["modelOptions"];
  if (value === undefined) return undefined;

  if (!isRecord(value)) {
    throw new Error(`${path} の modelOptions はオブジェクトにしてください`);
  }

  const options: ModelOptionsSettings = {};
  for (const [model, entry] of Object.entries(value)) {
    if (!isModelId(model)) {
      throw new Error(
        `${path} の modelOptions に使えないモデル ID があります: ${JSON.stringify(model)}（"provider/model" の形式にしてください）`,
      );
    }
    options[model] = readModelOption(model, entry, path);
  }
  return options;
}

function readModelOption(model: string, raw: unknown, path: string): ModelOptionSettings {
  if (!isRecord(raw)) {
    throw new Error(`${path} の modelOptions.${model} はオブジェクトにしてください`);
  }

  assertKnownKeys(raw, MODEL_OPTION_KEYS, `${path} の modelOptions.${model}`);
  const source = raw;

  const effort = source["reasoningEffort"];
  if (effort === undefined) return {};
  if (typeof effort !== "string" || effort.trim().length === 0) {
    throw new Error(`${path} の modelOptions.${model}.reasoningEffort は空でない文字列にしてください`);
  }
  return { reasoningEffort: effort.trim() };
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


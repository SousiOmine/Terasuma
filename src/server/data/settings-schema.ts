import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isEnvName } from "../../shared/env";
import { describeError } from "../../shared/errors";
import { isProviderId, mcpServerIdProblem, RESERVED_MCP_SERVER_IDS, type McpServerIdProblem } from "../../shared/ids";
import { isModelId, type ModelId } from "../../shared/model";
import { isWebSearchProviderId, WEB_SEARCH_PROVIDER_IDS } from "../websearch/index";

/**
 * config.json の形と、その読み書き。
 *
 * 設定ファイルは唯一の保存先なので、ここで「読める形か」「書ける形か」を決める。
 * 実行時の設定（ポートやディレクトリ）は config.ts、画面からの入力の整形は
 * settings-form.ts が受け持つ。このファイルは JSON と型の対応だけを持つ。
 */

/** 使う LLM 実装。mock は開発・テスト専用で、既定には決してならない。 */
export type EngineKind = "ai-sdk" | "mock";

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

/**
 * コンピュータ（デスクトップコンテナ）のコマンドへ渡す環境変数。名前 → 値。
 *
 * 値はエージェントにも画面にも渡さない。設定画面には名前だけを出す。
 * 保存先は設定ファイルなので、API キーと同じく平文で置かれる（書き込み時に 0600 にする）。
 */
export type EnvSettings = Record<string, string>;

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

/** 検索プロバイダ 1 件の設定。 */
export type WebSearchProviderSettings = {
  apiKey: string;
};

/** 検索プロバイダ id → 設定。並び順は設定ファイルに書かれた順のまま保つ。 */
export type WebSearchProvidersSettings = Record<string, WebSearchProviderSettings>;

/**
 * Web 検索の設定。
 * default は登録済みプロバイダの id。省略した場合は未設定（検索ツールを渡さない）。
 */
export type WebSearchSettings = {
  default?: string;
  providers: WebSearchProvidersSettings;
};

/** 実行時に使う Web 検索の設定。未設定を null で表す。 */
export type StoredWebSearchSettings = {
  default: string | null;
  providers: WebSearchProvidersSettings;
};

/** MCP サーバー 1 件に書ける項目。 */
const MCP_SERVER_KEYS = ["type", "command", "args", "env", "url"] as const;

/** Web 検索の設定に書ける項目。 */
const WEB_SEARCH_KEYS = ["default", "providers"] as const;

/** 検索プロバイダ 1 件に書ける項目。 */
const WEB_SEARCH_PROVIDER_KEYS = ["apiKey"] as const;

/** プロバイダ 1 件に書ける項目。 */
const PROVIDER_KEYS = ["apiKey", "baseUrl", "label"] as const;

/** モデル 1 件に書ける項目。 */
const MODEL_OPTION_KEYS = ["reasoningEffort"] as const;

const FILE_KEYS = ["model", "providers", "modelOptions", "mcpServers", "webSearch", "env", "port"] as const;
type FileKey = (typeof FILE_KEYS)[number];

/** config.json に書ける設定。書かなかった項目は既定値になる。 */
export type FileSettings = Partial<{
  model: ModelId;
  providers: ProvidersSettings;
  modelOptions: ModelOptionsSettings;
  mcpServers: McpServersSettings;
  webSearch: WebSearchSettings;
  env: EnvSettings;
  port: number;
}>;

/** 実行時に使うモデル設定。config.json のうち、設定画面から変えられる部分。 */
export type ModelSettings = {
  /** 既定のモデル。未設定なら null。 */
  model: ModelId | null;
  providers: ProvidersSettings;
  /** モデルごとの設定（思考強度など）。 */
  modelOptions: ModelOptionsSettings;
};

/** MCP サーバー id を受け付けられない理由を、設定ファイルの文言にする。 */
export function describeMcpServerIdProblem(value: string, problem: McpServerIdProblem): string {
  if (problem === "reserved") {
    const prefixes = RESERVED_MCP_SERVER_IDS.map((id) => `${id}_`).join(" / ");
    return `${JSON.stringify(value)} は Terasuma の内蔵ツール（${prefixes}）と同じ名前になるため使えません`;
  }
  return `${JSON.stringify(value)} は英小文字・数字・ハイフンで指定してください`;
}

/** 設定ファイルから、実行時に使うモデル設定だけを取り出す。 */
export function toModelSettings(file: FileSettings): ModelSettings {
  return {
    model: file.model ?? null,
    providers: file.providers ?? {},
    modelOptions: file.modelOptions ?? {},
  };
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
      throw new Error(
        `${path} の model は "provider/model" の形式にしてください（現在の値: ${JSON.stringify(model)}）`,
      );
    }
    settings.model = model;
  }

  const providers = readProviders(source, path);
  if (providers !== undefined) settings.providers = providers;

  const modelOptions = readModelOptions(source, path);
  if (modelOptions !== undefined) settings.modelOptions = modelOptions;

  const mcpServers = readMcpServers(source, path);
  if (mcpServers !== undefined) settings.mcpServers = mcpServers;

  const webSearch = readWebSearch(source, path);
  if (webSearch !== undefined) settings.webSearch = webSearch;

  const env = readEnv(source, path);
  if (env !== undefined) settings.env = env;

  const port = readNumber(source, "port", path);
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${path} の port は 1 から 65535 の整数にしてください（現在の値: ${port}）`);
    }
    settings.port = port;
  }

  return settings;
}

/**
 * 設定ファイルを書き換える。設定画面からの変更と、手で編集した内容の取り込みに使う。
 * 書き込みの途中で落ちても元のファイルが壊れないよう、一時ファイル経由で置き換える。
 * プロバイダの API キーとコンピュータの環境変数が入るので、他の利用者から読めないよう 0600 にする。
 */
export function writeSettingsFile(path: string, settings: FileSettings): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, serialize(settings), "utf8");
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** 設定ファイルに書く文字列。項目の並びは常に同じにして、差分を読みやすくする。 */
function serialize(settings: FileSettings): string {
  const ordered: Record<string, unknown> = {};
  if (settings.model !== undefined) ordered["model"] = settings.model;
  if (settings.providers !== undefined) ordered["providers"] = settings.providers;
  if (settings.modelOptions !== undefined) ordered["modelOptions"] = settings.modelOptions;
  if (settings.webSearch !== undefined) ordered["webSearch"] = settings.webSearch;
  if (settings.mcpServers !== undefined) ordered["mcpServers"] = settings.mcpServers;
  if (settings.env !== undefined) ordered["env"] = settings.env;
  if (settings.port !== undefined) ordered["port"] = settings.port;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * プロバイダ 1 件の設定を検証し、保存できる形に整える。
 *
 * baseUrl を持つものは OpenAI 互換の独自エンドポイントで、接続先を利用者が決める。
 * 持たないものは models.dev のカタログのプロバイダとして扱う。カタログは起動後に取り直すため、
 * ここでは登録の有無を確かめない（呼び出しの前に resolveModel が、カタログと突き合わせて止める）。
 * 既定値で埋め合わせると「設定したつもりで繋がらない」状態になるので、ここでは何も補わない。
 */
export function normalizeProvider(raw: ProviderSettings, source: string): ProviderSettings {
  const isEndpoint = raw.baseUrl !== undefined;

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

/**
 * 接続先の URL を検証する。末尾のスラッシュは落として、URL の組み立てを単純にする。
 * プロバイダの baseUrl も MCP サーバーの url も指す先は 1 つなので、同じ扱いにする。
 */
export function normalizeHttpUrl(value: string, source: string, what: string): string {
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
    throw new Error(
      `${source} の ${what} は http:// か https:// で始めてください（現在の値: ${JSON.stringify(value)}）`,
    );
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
      throw new Error(`${path} の mcpServers に使えない id があります: ${describeMcpServerIdProblem(id, problem)}`);
    }
    servers[id] = readMcpServerEntry(id, entry, path);
  }
  return servers;
}

/**
 * MCP サーバー 1 件を読む。
 * type の取り違えは起動時に落とす（command を url として繋ぎに行くような失敗を作らない）。
 * 画面から来た入力を検証するときも、同じ規則をここに任せる。
 */
export function readMcpServerEntry(id: string, raw: unknown, path: string): McpServerSettings {
  const where = `${path} の mcpServers.${id}`;
  if (!isRecord(raw)) {
    throw new Error(`${where} はオブジェクトにしてください`);
  }

  assertKnownKeys(raw, MCP_SERVER_KEYS, where);
  const source = raw;

  const type = source["type"];
  if (type === "stdio") return readStdioServer(source, where);
  if (type === "http") return readHttpServer(source, where);

  throw new Error(`${where} の type は "stdio" か "http" にしてください（現在の値: ${JSON.stringify(type)}）`);
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
      if (!isEnvName(name)) {
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

/** Web 検索の設定を読む。未設定なら undefined。 */
function readWebSearch(source: Record<string, unknown>, path: string): WebSearchSettings | undefined {
  const value = source["webSearch"];
  if (value === undefined) return undefined;

  if (!isRecord(value)) {
    throw new Error(`${path} の webSearch はオブジェクトにしてください`);
  }

  assertKnownKeys(value, WEB_SEARCH_KEYS, `${path} の webSearch`);
  const providers = readWebSearchProviders(value["providers"], path);
  const defaultId = readWebSearchDefault(value["default"], providers, path);

  return { providers, ...(defaultId === null ? {} : { default: defaultId }) };
}

/** 検索プロバイダの一覧を読む。id は保存された並び順のまま保つ。 */
function readWebSearchProviders(value: unknown, path: string): WebSearchProvidersSettings {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`${path} の webSearch.providers はオブジェクトにしてください`);
  }

  const providers: WebSearchProvidersSettings = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isWebSearchProviderId(id)) {
      throw new Error(
        `${path} の webSearch.providers に使えない id があります: ${JSON.stringify(id)}` +
          `（使える id: ${WEB_SEARCH_PROVIDER_IDS.join(", ")}）`,
      );
    }
    providers[id] = readWebSearchProviderEntry(id, entry, path);
  }
  return providers;
}

/**
 * 検索プロバイダ 1 件を読む。
 * 画面から来た入力を検証するときも、同じ規則をここに任せる。
 */
export function readWebSearchProviderEntry(id: string, raw: unknown, path: string): WebSearchProviderSettings {
  const where = `${path} の webSearch.providers.${id}`;
  if (!isRecord(raw)) {
    throw new Error(`${where} はオブジェクトにしてください`);
  }

  assertKnownKeys(raw, WEB_SEARCH_PROVIDER_KEYS, where);
  const apiKey = raw["apiKey"];
  if (typeof apiKey !== "string") {
    throw new Error(`${where} の apiKey は文字列で指定してください`);
  }

  return normalizeWebSearchProvider(id, apiKey, where);
}

/** 検索プロバイダ 1 件の設定を検証し、保存できる形に整える。 */
export function normalizeWebSearchProvider(id: string, apiKey: string, source: string): WebSearchProviderSettings {
  if (!isWebSearchProviderId(id)) {
    throw new Error(
      `${source} の検索プロバイダ id が不明です: ${JSON.stringify(id)}` +
        `（使える id: ${WEB_SEARCH_PROVIDER_IDS.join(", ")}）`,
    );
  }

  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new Error(`${source} の apiKey を空にはできません`);
  }
  return { apiKey: trimmed };
}

/** 既定の検索プロバイダを読む。未設定なら null。登録の無い id は起動時に落とす。 */
function readWebSearchDefault(value: unknown, providers: WebSearchProvidersSettings, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${path} の webSearch.default は文字列で指定してください`);
  }

  const id = value.trim();
  if (id.length === 0) {
    throw new Error(`${path} の webSearch.default を空にはできません`);
  }
  if (providers[id] === undefined) {
    throw new Error(`${path} の webSearch.default が指す検索プロバイダ ${id} は設定されていません`);
  }
  return id;
}

/**
 * コンピュータのコマンドへ渡す環境変数を読む。
 *
 * 名前はシェルが読める形、値は空でない文字列だけを受け付ける。
 * NUL は podman exec の引数にできず、渡すとコマンドが起動しないため、ここで止める。
 */
function readEnv(source: Record<string, unknown>, path: string): EnvSettings | undefined {
  const value = source["env"];
  if (value === undefined) return undefined;

  if (!isRecord(value)) {
    throw new Error(`${path} の env はオブジェクトにしてください`);
  }

  const variables: EnvSettings = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isEnvName(name)) {
      throw new Error(`${path} の env に環境変数名として使えない名前があります: ${JSON.stringify(name)}`);
    }
    if (typeof entry !== "string") {
      throw new Error(`${path} の env.${name} は文字列にしてください`);
    }
    if (entry.length === 0) {
      throw new Error(`${path} の env.${name} を空にはできません`);
    }
    if (entry.includes("\0")) {
      throw new Error(`${path} の env.${name} に NUL 文字は使えません`);
    }
    variables[name] = entry;
  }
  return variables;
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

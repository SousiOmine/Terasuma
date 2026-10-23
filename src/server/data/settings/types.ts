import { RESERVED_MCP_SERVER_IDS, type McpServerIdProblem } from "../../../shared/ids";
import type { ModelId } from "../../../shared/model";

/**
 * config.json の形と、その読み書き。
 *
 * 設定ファイルは唯一の保存先なので、ここで「読める形か」「書ける形か」を決める。
 * 実行時の設定（ポートやディレクトリ）は config.ts、画面からの入力の整形は
 * form.ts が受け持つ。このファイルは JSON と型の対応だけを持つ。
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
export type ModelOptionsSettings = Record<string, ModelOptionSettings>;

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

export const FILE_KEYS = [
  "model",
  "providers",
  "modelOptions",
  "mcpServers",
  "webSearch",
  "env",
  "port",
] as const;
export type FileKey = (typeof FILE_KEYS)[number];

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

/**
 * サーバとクライアントで共有する型。
 * バンドルすると別々のファイルになるため、実行時のコードは置かず型だけにする。
 */

import type { ModelId } from "./model";

export type MessageRole = "user" | "assistant";

/** モデル呼び出し 1 回分のトークン消費。cachedInputTokens はプロンプトキャッシュのヒット分。 */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

/**
 * メッセージを組み立てている部品。
 * 本文とツールの呼び出しが混ざるため、順序を保ったまま部分ごとに持つ。
 */
export type MessagePart =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      /** モデルが発行した呼び出し id。結果と突き合わせる。 */
      id: string;
      /** 接続している MCP サーバーの id。 */
      server: string;
      /** MCP サーバーが公開しているツール名。 */
      tool: string;
      /** モデルが組み立てた引数。 */
      args: unknown;
    }
  | {
      type: "tool-result";
      id: string;
      server: string;
      tool: string;
      /** ツールがエラーを返したかどうか。 */
      failed: boolean;
      /** ツールが返した内容（モデルへ渡るのと同じ文字列）。 */
      output: string;
    };

export type ChatMessage = {
  id: string;
  sessionId: string;
  /** セッション内の連番。1 から始まり、履歴の並び順を確定させる。 */
  seq: number;
  role: MessageRole;
  /** 本文（parts があるときは text 部分を連結したもの）。 */
  content: string;
  /** ツール呼び出しを含むメッセージだけが持つ。含まないメッセージでは null。 */
  parts: MessagePart[] | null;
  /** epoch ミリ秒 */
  createdAt: number;
  usage: TokenUsage | null;
};

export type Session = {
  id: string;
  /** 最初のユーザー発言から作る。表示文言は言語ごとに変わるため、未設定は null で持つ。 */
  title: string | null;
  /** epoch ミリ秒 */
  createdAt: number;
  updatedAt: number;
};

/**
 * API が返す機械可読なコード。画面に出す文言はクライアント側の i18n で解決する。
 * provider_* は、プロバイダの設定と接続確認で起きる失敗。
 */
export type ApiErrorCode =
  | "invalid_request"
  | "session_not_found"
  | "model_error"
  | "model_not_configured"
  | "provider_not_found"
  | "provider_exists"
  | "provider_auth_failed"
  | "provider_unreachable"
  | "provider_no_models"
  | "catalog_unavailable"
  | "mcp_server_not_found"
  | "mcp_server_exists"
  | "mcp_authorization_failed"
  | "settings_write_failed"
  | "internal_error";

/** 設定画面に出すプロバイダ 1 件。API キーそのものは返さず、設定済みかどうかだけを返す。 */
export type ProviderView = {
  /** config.json の providers のキー。モデル ID の先頭部分と一致する。 */
  id: string;
  /** 画面に出す名前。既知のプロバイダはカタログの名前、独自エンドポイントは label。 */
  name: string;
  /** OpenAI 互換の独自エンドポイントのときだけ入る。 */
  baseUrl: string | null;
  hasApiKey: boolean;
};

/** モデル設定の現在の状態。設定を変える API はすべてこの形を返す。 */
export type ModelSettingsView = {
  /** 既定のモデル。未設定なら null。 */
  model: ModelId | null;
  providers: ProviderView[];
};

/** プロバイダに接続するための入力。接続確認と追加・変更で同じ形を使う。 */
export type ProviderCredentials = {
  apiKey: string | null;
  /** OpenAI 互換の独自エンドポイントのときだけ。 */
  baseUrl: string | null;
  /** 独自エンドポイントの表示名。既知のプロバイダでは使わない。 */
  label: string | null;
};

/** 接続確認の入力。 */
export type ProviderForm = ProviderCredentials & {
  id: string;
};

/** 接続確認の結果。verified が false のときは、確認する手段が無かったことを表す。 */
export type ProviderCheckResult = {
  verified: boolean;
  /** 確認できたときに得られたモデル ID。独自エンドポイントのモデル選択に使う。 */
  models: readonly string[];
};

/**
 * 設定画面に並べるプロバイダ 1 件（models.dev のカタログ）。
 * モデルの呼び出し方（どの URL に投げるか）は Mastra が持つので、ここには出さない。
 */
export type CatalogProviderView = {
  /** モデル ID の先頭部分になる id。 */
  id: string;
  name: string;
  /** このプロバイダのモデルまでを持つかどうか。 */
  models: number;
};

/** 既定のモデルに設定できる思考強度。 */
export type ReasoningView = {
  /** 対象のモデル。未設定なら null。 */
  model: ModelId | null;
  /** このモデルに保存されている思考強度。未設定なら null。 */
  effort: string | null;
  /** 選べる値。思考強度を渡せないモデルでは空になる。 */
  values: readonly string[];
};

/** プロバイダの追加。追加と同時に既定のモデルを決められる。 */
export type AddProviderForm = ProviderForm & {
  /** 既定にするモデル。決めない場合は null。 */
  defaultModel: ModelId | null;
};

/**
 * 1 ターン分のストリーミングで流れるイベント。
 * ツール呼び出しの本体（引数・結果）はメッセージとして保存されるので、
 * ここでは流れてくる順に組み立てるための断片だけを運ぶ。
 */
export type ChatEvent =
  | { type: "user-message"; message: ChatMessage }
  | { type: "assistant-start"; id: string; createdAt: number }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "tool-call"; id: string; part: Extract<MessagePart, { type: "tool-call" }> }
  | { type: "tool-result"; id: string; part: Extract<MessagePart, { type: "tool-result" }> }
  | { type: "assistant-done"; message: ChatMessage }
  | { type: "error"; code: ApiErrorCode; detail: string | null };

/** MCP サーバーの接続状態。 */
export type McpServerState =
  /** まだ接続を確かめていない。 */
  | "unknown"
  | "connected"
  /** ブラウザでの認可を待っている。 */
  | "authorizing"
  /** 認可が必要（認可すると繋がる可能性がある）。 */
  | "authorization_required"
  | "failed";

/** MCP サーバー 1 件の接続状態。 */
export type McpServerStatusView = {
  state: McpServerState;
  /** 接続できたときに公開されているツール名。 */
  tools: readonly string[];
  /** 繋がらない理由。無ければ null。 */
  detail: string | null;
};

/** 設定画面に並べる MCP サーバー 1 件。 */
export type McpServerView = {
  id: string;
  type: "stdio" | "http";
  /** ローカルのサーバーを起動するコマンド。http では null。 */
  command: string | null;
  /** コマンドに渡す引数（stdio のみ）。 */
  args: readonly string[];
  /** 子プロセスに足す環境変数（stdio のみ）。 */
  env: Record<string, string>;
  /** http のサーバーの URL。stdio では null。 */
  url: string | null;
  status: McpServerStatusView;
};

/**
 * 追加の前に確かめる接続の結果。
 * サーバーが認可を求めた場合は、ブラウザで開く画面の URL も返る。
 */
export type McpTestView = McpServerStatusView & {
  /** 認可が必要なときに開く画面の URL。要らないときは null。 */
  authorizationUrl: string | null;
};

/** MCP 設定の現在の状態。設定を変える API はすべてこの形を返す。 */
export type McpServersView = {
  servers: McpServerView[];
};

/** MCP サーバーの追加・変更の入力。未入力は null。 */
export type McpServerForm = {
  id: string;
  type: "stdio" | "http";
  command: string | null;
  args: readonly string[] | null;
  env: Record<string, string> | null;
  url: string | null;
};

/** 認可を始めた結果。開く URL が返るか、すでに認可済みか。 */
export type McpAuthorizationView = {
  /** ブラウザで開く認可画面の URL。すでに認可済みなら null。 */
  url: string | null;
};

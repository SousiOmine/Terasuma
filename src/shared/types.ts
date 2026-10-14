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

export type ChatMessage = {
  id: string;
  sessionId: string;
  /** セッション内の連番。1 から始まり、履歴の並び順を確定させる。 */
  seq: number;
  role: MessageRole;
  content: string;
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
 * ツール呼び出しを足すときは、この union に種類を増やすだけで済む形にしてある。
 */
export type ChatEvent =
  | { type: "user-message"; message: ChatMessage }
  | { type: "assistant-start"; id: string; createdAt: number }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "assistant-done"; message: ChatMessage }
  | { type: "error"; code: ApiErrorCode; detail: string | null };

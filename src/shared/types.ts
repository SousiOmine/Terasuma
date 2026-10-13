/**
 * サーバとクライアントで共有する型。
 * バンドルすると別々のファイルになるため、実行時のコードは置かず型だけにする。
 */

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

/** API が返す機械可読なコード。画面に出す文言はクライアント側の i18n で解決する。 */
export type ApiErrorCode =
  | "invalid_request"
  | "session_not_found"
  | "model_error"
  | "internal_error";

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

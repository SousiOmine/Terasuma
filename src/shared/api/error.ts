/**
 * 失敗のコード。画面はこの値から i18n の文言を選ぶ。
 * 一覧を値として持ち、型はそこから導く（型と一覧を別々に書くと片方だけ古くなる）。
 */

/**
 * サーバが返す機械可読なコード。画面に出す文言はクライアント側の i18n で解決する。
 * provider_* は、プロバイダの設定と接続確認で起きる失敗。
 * container_* は、コンテナの準備と操作で起きる失敗。
 *
 * 一覧を値としても持ち、型はそこから導く。型と一覧を別々に書くと、
 * コードを足したときに片方だけ古くなり、画面が理由を出せなくなる。
 */
export const API_ERROR_CODES = [
  "invalid_request",
  "tera_not_found",
  "model_error",
  "model_not_configured",
  "provider_not_found",
  "provider_exists",
  "provider_auth_failed",
  "provider_unreachable",
  "provider_no_models",
  "catalog_unavailable",
  "mcp_server_not_found",
  "mcp_server_exists",
  "mcp_authorization_failed",
  "connection_not_found",
  "web_search_not_found",
  "web_search_exists",
  "container_build_failed",
  "container_start_failed",
  "container_not_running",
  "handover_not_pending",
  "env_request_not_pending",
  "turn_in_progress",
  "turn_not_running",
  "media_not_found",
  "not_found",
  "method_not_allowed",
  "settings_write_failed",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 失敗の応答の形。detail は理由の 1 文で、無ければ null。 */
export type ApiErrorBody = {
  code: ApiErrorCode;
  detail: string | null;
};

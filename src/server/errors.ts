import type { ApiErrorCode } from "../shared/api/error";

/**
 * 画面へ返す失敗。
 *
 * code は画面が文言を選ぶための印、status は HTTP の状態。
 * この 2 つを失敗そのものに持たせ、HTTP への変換は http/respond.ts の 1 か所だけで行う。
 * ハンドラは投げるだけにし、try/catch を各所に書かない。
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 入力が受け付けられない（400）。 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super("invalid_request", 400, message);
  }
}

/** 見つからない（404）。 */
export class ResourceNotFoundError extends AppError {
  constructor(code: ApiErrorCode, message: string) {
    super(code, 404, message);
  }
}

/** いまの状態では受け付けられない（409）。 */
export class ConflictError extends AppError {
  constructor(code: ApiErrorCode, message: string) {
    super(code, 409, message);
  }
}

/** 設定ファイルを書けなかった（500）。 */
export class SettingsWriteError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("settings_write_failed", 500, message, { cause });
  }
}

/** models.dev のカタログを使えない（502）。 */
export class CatalogUnavailableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("catalog_unavailable", 502, message, { cause });
  }
}

/** 設定に無い検索プロバイダを触ろうとしたときの失敗。 */
export class WebSearchProviderNotFound extends AppError {
  constructor(readonly providerId: string) {
    super("web_search_not_found", 404, `検索プロバイダ ${providerId} は設定されていません`);
  }
}

/** 同じ検索プロバイダを二重に追加しようとしたときの失敗。 */
export class WebSearchProviderExists extends AppError {
  constructor(readonly providerId: string) {
    super("web_search_exists", 409, `検索プロバイダ ${providerId} はすでに追加されています`);
  }
}

/** 設定に無いコネクタを触ろうとしたときの失敗。 */
export class ConnectorNotFound extends AppError {
  constructor(readonly connectorId: string) {
    super("connector_not_found", 404, `コネクタ ${connectorId} は設定されていません`);
  }
}

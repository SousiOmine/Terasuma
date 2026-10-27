import { ERROR_STATUS, type ApiErrorCode } from "../shared/api/error";

/**
 * 画面へ返す失敗。
 *
 * code は画面が文言を選ぶための印で、HTTP の状態は ERROR_STATUS がコードから決める。
 * 状態を失敗ごとに書くと、同じコードが場所によって 404 になったり 400 になったりして、
 * 画面が状態で分岐できなくなる。HTTP への変換は http/respond.ts の 1 か所だけで行う。
 * ハンドラは投げるだけにし、try/catch を各所に書かない。
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.status = ERROR_STATUS[code];
  }
}

/** 入力が受け付けられない（400）。 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super("invalid_request", message);
  }
}

/**
 * 入力の整形で起きた失敗を、そのまま 400 にする。
 *
 * 設定の検証は、設定ファイルを読む規則をそのまま使う（規則を書き写さない）。
 * その規則は Error を投げるので、画面へ返す形にここで揃える。
 * すでに AppError なら、そのまま投げ直す（理由とコードを潰さない）。
 */
export function asValidationError(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new ValidationError(error instanceof Error ? error.message : String(error));
}

/** 見つからない（404）。 */
export class ResourceNotFoundError extends AppError {
  constructor(code: ApiErrorCode, message: string) {
    super(code, message);
  }
}

/** いまの状態では受け付けられない（409）。 */
export class ConflictError extends AppError {
  constructor(code: ApiErrorCode, message: string) {
    super(code, message);
  }
}

/** 設定ファイルを書けなかった（500）。 */
export class SettingsWriteError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("settings_write_failed", message, { cause });
  }
}

/** models.dev のカタログを使えない（502）。 */
export class CatalogUnavailableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("catalog_unavailable", message, { cause });
  }
}

/** 設定に無い検索プロバイダを触ろうとしたときの失敗。 */
export class WebSearchProviderNotFound extends AppError {
  constructor(readonly providerId: string) {
    super("web_search_not_found", `検索プロバイダ ${providerId} は設定されていません`);
  }
}

/** 同じ検索プロバイダを二重に追加しようとしたときの失敗。 */
export class WebSearchProviderExists extends AppError {
  constructor(readonly providerId: string) {
    super("web_search_exists", `検索プロバイダ ${providerId} はすでに追加されています`);
  }
}

/** 設定に無いコネクタを触ろうとしたときの失敗。 */
export class ConnectorNotFound extends AppError {
  constructor(readonly connectorId: string) {
    super("connector_not_found", `コネクタ ${connectorId} は設定されていません`);
  }
}

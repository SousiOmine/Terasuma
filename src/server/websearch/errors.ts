/**
 * 検索の失敗。
 *
 * プロバイダごとに違う失敗（401、429、残高不足、繋がらない）を、
 * 呼び出し側が扱える少数の種類にまとめる。文言はそのままモデルへ渡せる英語にする。
 */

export type WebSearchErrorCode =
  /** API キーが受け付けられなかった（401 / 403）。 */
  | "auth"
  /** レート制限に達した（429）。 */
  | "rate_limit"
  /** 残高や利用枠が足りない（402 など）。 */
  | "quota"
  /** 接続できない・タイムアウト・5xx。 */
  | "unavailable"
  /** 入力や URL が受け付けられなかった（400 / 404 など）。 */
  | "invalid"
  /** そのプロバイダでは扱えない（PDF の直接取得など）。 */
  | "unsupported";

export class WebSearchError extends Error {
  /** HTTP の状態。分からなければ null。 */
  readonly status: number | null;

  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WebSearchError";
    this.status = options.status ?? null;
  }
}

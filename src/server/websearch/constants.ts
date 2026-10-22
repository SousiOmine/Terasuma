/**
 * 検索ライブラリの既定値。
 * 利用側（Terasuma）が同じ値を書き直さないよう、ここに 1 つだけ置く。
 */

/** 1 回の検索で返す件数。 */
export const DEFAULT_SEARCH_LIMIT = 5;

/** 1 回の検索で返せる件数の上限。 */
export const MAX_SEARCH_LIMIT = 10;

/** ページ取得で返す本文の既定の上限（文字数）。 */
export const DEFAULT_FETCH_CHARS = 20_000;

/** ページ取得で返せる本文の上限（文字数）。 */
export const MAX_FETCH_CHARS = 100_000;

/** 検索 1 回の打ち切り。 */
export const SEARCH_TIMEOUT_MS = 20_000;

/** ページ取得 1 回の打ち切り。TinyFish の取得は長いので、検索より長く取る。 */
export const FETCH_TIMEOUT_MS = 60_000;

/** 直接取得で読む本文の上限（バイト数）。Content-Length の判定に使う。 */
export const MAX_DIRECT_FETCH_BYTES = 5 * 1024 * 1024;

/** 直接取得で保持する本文の上限（文字数）。 */
export const MAX_DIRECT_FETCH_CHARS = 2_000_000;

/** 検索結果の抜粋の上限（文字数）。 */
export const MAX_SNIPPET_CHARS = 600;

/** エラー本文から取り出す文言の上限（文字数）。 */
export const MAX_ERROR_DETAIL_CHARS = 400;

/**
 * 例外を、画面やログに出せる 1 行にする。
 * 投げられる値は Error とは限らない（文字列を投げるコードもある）ため、ここで 1 つの形に揃える。
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

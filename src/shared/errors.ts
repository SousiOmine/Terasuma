import { recordOf } from "./guards";

/**
 * 例外を、画面やログに出せる 1 行にする。
 * 投げられる値は Error とは限らない（文字列を投げるコードもある）ため、ここで 1 つの形に揃える。
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 例外や `{ message }` から、人へ見せる 1 文を取り出す。
 * 取り出せない形なら null を返し、呼び出し側が別の文言へ落とせるようにする。
 */
export function messageOf(value: unknown): string | null {
  if (value instanceof Error) return value.message;

  const message = recordOf(value)?.["message"];
  return typeof message === "string" ? message : null;
}

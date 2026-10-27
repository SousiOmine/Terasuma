import { recordOf } from "../../../shared/guards";
/**
 * プロバイダの応答を読むための小さな関数。
 *
 * どのプロバイダも「results の配列から、タイトル・URL・抜粋・日付を取り出す」形なので、
 * 型の確かめ方をここに 1 つだけ置く。応答の形が変わっても、読めない項目は空にして先へ進む。
 */

import { MAX_SEARCH_LIMIT, MAX_SNIPPET_CHARS } from "../constants";
import { htmlToText } from "../html";
import { truncateText } from "../../../shared/text";
import { clampInt } from "../../../shared/numbers";

/** オブジェクトの配列を、読める要素だけに絞って返す。 */
export function arrayOf(value: unknown, key: string): Record<string, unknown>[] {
  const list = recordOf(value)?.[key];
  if (!Array.isArray(list)) return [];

  return list.map(recordOf).filter((item): item is Record<string, unknown> => item !== null);
}

/** 文字列ならその値、そうでなければ fallback。 */
export function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** 空でない文字列ならその値、そうでなければ null。 */
export function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 件数を、プロバイダへ渡せる範囲に収める。 */
export function numberLimit(value: number): number {
  return clampInt(value, 1, MAX_SEARCH_LIMIT);
}

/** 抜粋を、1 行に収まる長さにする。HTML が混ざるプロバイダ（Brave）もあるのでタグを落とす。 */
export function snippetOf(value: string, maxChars = MAX_SNIPPET_CHARS): string {
  const text = htmlToText(value).replace(/\s+/g, " ").trim();
  return truncateText(text, maxChars, "parens");
}

/** ハイライトの配列を 1 つの抜粋にする。 */

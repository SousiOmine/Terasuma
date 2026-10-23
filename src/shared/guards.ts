/** オブジェクトとして読める値かどうか。配列は含めない。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** オブジェクトとして読める値だけを取り出す。読めなければ null。 */
export function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

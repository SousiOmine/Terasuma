/**
 * 履歴検索の期間（YYYY-MM-DD）の扱い。
 *
 * 画面もモデルも日付は YYYY-MM-DD で指定する。範囲はその端末のローカル時刻で決め、
 * to はその日を含める（半開区間の上端は翌日の 0 時）。
 * 実在しない日付（2 月 30 日など）は、Date が繰り上げる前に断る。
 */

/** 日付の形。 */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 期間の端。 */
export type Range = {
  /** これ以降。制限しないときは null。 */
  since: number | null;
  /** これ未満。制限しないときは null。 */
  until: number | null;
};

/** 年月日。 */
type Day = { year: number; month: number; day: number };

/**
 * from / to（YYYY-MM-DD）を、ローカル時刻の半開区間 [from の 0 時, to の翌日 0 時) にする。
 * to はその日を含めるので、上端は翌日の 0 時（未満）にする。
 */
export function dayRange(from: string | undefined, to: string | undefined): Range {
  const fromText = cleanDay(from);
  const toText = cleanDay(to);

  const since = fromText === null ? null : startOfDay(parseDay(fromText, "from"));
  const until = toText === null ? null : nextDayStart(parseDay(toText, "to"));
  if (since !== null && until !== null && since >= until) {
    throw new Error(`from (${fromText}) is after to (${toText}). Both must be YYYY-MM-DD dates in local time.`);
  }
  return { since, until };
}

/** その日の 0 時（ローカル時刻）。 */
function startOfDay(day: Day): number {
  return new Date(day.year, day.month - 1, day.day).getTime();
}

/** その日の翌日の 0 時（ローカル時刻）。月の終わりは Date が繰り上げる。 */
function nextDayStart(day: Day): number {
  return new Date(day.year, day.month - 1, day.day + 1).getTime();
}

/** 日付として読む。形式と実在する日かを確かめる。 */
function parseDay(value: string, field: string): Day {
  const match = DAY_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${field} must be a YYYY-MM-DD date in local time, got "${value}".`);
  }

  const year = Number(match[1] ?? "");
  const month = Number(match[2] ?? "");
  const day = Number(match[3] ?? "");

  // 2 月 30 日のような日は Date が翌月へ繰り上げる。組み立て直して元と一致するかで見分ける。
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`${field} is not a real date: "${value}".`);
  }
  return { year, month, day };
}

/** 前後の空白を落とした日付。空なら null。 */
export function cleanDay(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length === 0 ? null : text;
}


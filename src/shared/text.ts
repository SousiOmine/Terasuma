/**
 * 文字列の整形。
 *
 * 画面・モデル・ログで同じ意図の整形を書き写さないための置き場。
 * 表示の違い（空白の有無、切った印の文面）は引数で選び、実装は 1 つにする。
 */

/** 切り詰めたことを示す書式。 */
export type TruncateStyle =
  /** `[... N more characters truncated]`（要約に見せる履歴）。 */
  | "brackets"
  /** `… (N more characters)`（履歴検索の結果）。 */
  | "parens"
  /** `… (truncated)`（ツールの説明など、件数が要らないもの）。 */
  | "marked";

/** 文字列を上限までに切り、切ったことを末尾に残す。 */
export function truncateText(text: string, limit: number, style: TruncateStyle): string {
  if (text.length <= limit) return text;

  const rest = text.length - limit;
  const head = text.slice(0, limit);
  switch (style) {
    case "brackets":
      return `${head}\n[... ${rest} more characters truncated]`;
    case "parens":
      return `${head}\n… (${rest} more characters)`;
    case "marked":
      return `${head}… (truncated)`;
  }
}

/**
 * バイト数を読みやすくする。
 * space を false にすると `1.0KB`（ツールの戻り値は pi と同じ詰めた形にしている）。
 */
export function formatBytes(bytes: number, options: { space?: boolean } = {}): string {
  const space = options.space === false ? "" : " ";

  if (bytes < 1024) return `${bytes}${space}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}${space}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}${space}MB`;
}

/**
 * 端末のローカル時刻で `YYYY-MM-DD` を返す。
 * time を付けると `YYYY-MM-DD HH:mm`（履歴の見出しに使う）。
 */
export function formatLocalDate(at: number, options: { time?: boolean } = {}): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  return options.time === true ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

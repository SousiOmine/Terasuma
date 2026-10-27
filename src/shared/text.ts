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
 * 文字列を 1 行に詰める（改行と連続する空白を 1 つの空白にする）。
 * limit を渡すと、その長さで切って末尾に `…` を付ける。
 * 失敗の理由や説明を、表やログの 1 行に収めるときに使う。
 */
export function oneLine(text: string, limit?: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (limit === undefined || line.length <= limit) return line;
  return `${line.slice(0, limit)}…`;
}

/**
 * 文字列の UTF-8 でのバイト数。
 * shared はブラウザでも動くので、Buffer ではなく TextEncoder を使う（どちらにもある標準の口）。
 */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * UTF-8 のバイト数で先頭から切る。文字の境目は壊さない。
 * ファイル名や、コンテナのコマンドへ渡す引数の上限に合わせるときに使う。
 */
export function truncateBytesFromStart(text: string, maxBytes: number): string {
  let used = 0;
  let result = "";

  for (const char of text) {
    const size = utf8Length(char);
    if (used + size > maxBytes) break;
    used += size;
    result += char;
  }
  return result;
}

/**
 * UTF-8 のバイト数で末尾から残す。文字の境目は壊さない。
 * コマンドの出力は末尾に結論が出るので、切るのは先頭側にする。
 */
export function truncateBytesFromEnd(text: string, maxBytes: number): string {
  let used = 0;
  const kept: string[] = [];

  // 後ろから 1 文字ずつ足し、上限を超えたら止める（文字の境目は for...of が保つ）。
  const chars = [...text];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    if (char === undefined) continue;

    const size = utf8Length(char);
    if (used + size > maxBytes) break;
    used += size;
    kept.push(char);
  }
  return kept.reverse().join("");
}

/** 末尾 limit 文字を取る。先頭がサロゲートペアの後半なら、そこは落とす（壊れた文字を残さない）。 */
export function tailChars(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const tail = text.slice(text.length - limit);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
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

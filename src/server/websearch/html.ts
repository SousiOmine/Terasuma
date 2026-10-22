/**
 * HTML から本文を取り出す。
 *
 * 取得 API を持たないプロバイダ（Brave / Perplexity）のページ取得と、
 * 検索結果の抜粋の整形に使う。DOM の実装には頼らず、タグと実体参照を落とすだけの簡易な変換にする
 * （読みやすさを優先し、完全な HTML パーサは持ち込まない）。
 */

const TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;

/** 本文を含まない要素。中身ごと落とす。 */
const REMOVED_ELEMENTS = ["script", "style", "noscript", "svg", "template", "iframe", "canvas", "head"] as const;

/** 行の区切りになる終了タグ。 */
const BLOCK_END_PATTERN =
  /<\/(?:p|div|li|tr|h[1-6]|blockquote|pre|table|thead|tbody|section|article|header|footer|main|aside|nav|figure|figcaption|dl|dt|dd)\s*>/gi;

const BR_PATTERN = /<br\b[^>]*\/?>/gi;
const TAG_PATTERN = /<[^>]*>/g;
const WHITESPACE_PATTERN = /[ \t\f\v\u00a0]+/g;
const BLANK_LINES_PATTERN = /\n{3,}/g;

/** よく出る実体参照。無い名前はそのまま残す。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** ページのタイトル。無ければ null。 */
export function pageTitle(html: string): string | null {
  const match = TITLE_PATTERN.exec(html);
  if (match === null) return null;

  const title = decodeEntities(match[1] ?? "")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
  return title.length === 0 ? null : title;
}

/** HTML を、読める本文にする。 */
export function htmlToText(html: string): string {
  let text = html;

  for (const tag of REMOVED_ELEMENTS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
  }

  text = text.replace(BLOCK_END_PATTERN, "\n");
  text = text.replace(BR_PATTERN, "\n");
  text = text.replace(TAG_PATTERN, "");
  text = decodeEntities(text);

  return normalize(text);
}

/** 実体参照を文字に戻す。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const digits = hex ? entity.slice(2) : entity.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;

      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }

    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** 行内の余分な空白を詰め、空行を 1 つまでにし、前後の空白を落とす。 */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(WHITESPACE_PATTERN, " ").trim())
    .join("\n")
    .replace(BLANK_LINES_PATTERN, "\n\n")
    .trim();
}

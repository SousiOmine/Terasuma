import type { MarkdownInline } from "./types";
import { safeHref } from "./url";

/**
 * インライン（強調・打ち消し・コード・リンク・裸の URL）の解釈。
 *
 * 閉じていない記法は、入力の途中でも画面を壊さないよう、そのままの文字として扱う。
 * リンクの URL は safeHref を通す（javascript: のような危険な URL はリンクにしない）。
 */

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const ESCAPABLE = "\\`*_{}[]()#+-.!<>|~";

export function parseInline(source: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let text = "";
  let i = 0;

  const flush = (): void => {
    if (text.length === 0) return;

    nodes.push({ type: "text", text });
    text = "";
  };

  while (i < source.length) {
    const char = source[i]!;

    if (char === "\\") {
      const next = source[i + 1];
      if (next !== undefined && ESCAPABLE.includes(next)) {
        text += next;
        i += 2;
        continue;
      }
    }

    if (char === "\n") {
      flush();
      nodes.push({ type: "break" });
      i++;
      continue;
    }

    if (char === "`") {
      const size = runLength(source, i, "`");
      const close = findCodeSpanClose(source, i + size, size);
      if (close !== -1) {
        flush();
        nodes.push({ type: "code", text: normalizeCodeSpan(source.slice(i + size, close)) });
        i = close + size;
        continue;
      }

      text += source.slice(i, i + size);
      i += size;
      continue;
    }

    // 画像は読み込まず、リンクとして出す（本文だけで外部へ取りに行かせない）。
    if (char === "!" && source[i + 1] === "[") {
      const link = matchLink(source, i + 1);
      if (link !== null) {
        flush();
        nodes.push({
          type: "link",
          href: link.href,
          children: link.label.length > 0 ? parseInline(link.label) : [{ type: "text", text: link.href }],
        });
        i = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = matchLink(source, i);
      if (link !== null) {
        flush();
        nodes.push({ type: "link", href: link.href, children: parseInline(link.label) });
        i = link.end;
        continue;
      }
    }

    if (char === "<") {
      const auto = /^<(https?:\/\/[^>\s]+)>/i.exec(source.slice(i));
      if (auto !== null) {
        const href = safeHref(auto[1]!);
        if (href !== null) {
          flush();
          nodes.push({ type: "link", href, children: [{ type: "text", text: auto[1]! }] });
          i += auto[0].length;
          continue;
        }
      }
    }

    if (char === "*" || char === "_") {
      const emphasis = matchEmphasis(source, i, char);
      if (emphasis !== null) {
        flush();
        nodes.push(emphasis.node);
        i = emphasis.end;
        continue;
      }

      text += char;
      i++;
      continue;
    }

    if (char === "~" && source[i + 1] === "~") {
      const strike = matchStrike(source, i);
      if (strike !== null) {
        flush();
        nodes.push(strike.node);
        i = strike.end;
        continue;
      }

      text += char;
      i++;
      continue;
    }

    if (char === "h" && (source.startsWith("http://", i) || source.startsWith("https://", i))) {
      const url = matchBareUrl(source, i);
      if (url !== null) {
        flush();
        nodes.push({ type: "link", href: url.href, children: [{ type: "text", text: url.text }] });
        i = url.end;
        continue;
      }
    }

    text += char;
    i++;
  }

  flush();
  return nodes;
}

type Delimited = { text: string; end: number };

/** 強調の記号。*** は太字と斜体、** は太字、* は斜体。 */
function matchEmphasis(source: string, start: number, marker: "*" | "_"): { node: MarkdownInline; end: number } | null {
  const run = runLength(source, start, marker);

  if (run >= 3) {
    const content = matchDelimited(source, start, marker, 3);
    if (content === null) return null;

    return {
      node: { type: "strong", children: [{ type: "em", children: parseInline(content.text) }] },
      end: content.end,
    };
  }

  if (run === 2) {
    const content = matchDelimited(source, start, marker, 2);
    if (content === null) return null;

    return { node: { type: "strong", children: parseInline(content.text) }, end: content.end };
  }

  const content = matchDelimited(source, start, marker, 1);
  if (content === null) return null;

  return { node: { type: "em", children: parseInline(content.text) }, end: content.end };
}

/**
 * 開いた記号と同じ数の記号が閉じる位置までを切り出す。
 * 中身の先頭と末尾が空白なら強調として扱わない（2 * 3 のような式を壊さない）。
 */
function matchDelimited(source: string, start: number, marker: "*" | "_", count: number): Delimited | null {
  const contentStart = start + count;
  const first = source[contentStart];
  if (first === undefined || /\s/.test(first)) return null;

  // 語の中の _ は斜体にしない（foo_bar_baz を壊さない）。
  if (marker === "_" && isWordChar(source[start - 1])) return null;

  const close = findDelimiterClose(source, contentStart, marker, count, count > 1);
  if (close === -1) return null;

  const text = source.slice(contentStart, close);
  if (text.length === 0 || /\s$/.test(text)) return null;

  return { text, end: close + count };
}

function findDelimiterClose(
  source: string,
  from: number,
  marker: "*" | "_",
  count: number,
  allowNewline: boolean,
): number {
  let i = from;

  while (i < source.length) {
    const char = source[i]!;

    if (char === "\\") {
      i += 2;
      continue;
    }
    if (!allowNewline && char === "\n") return -1;
    if (char !== marker) {
      i++;
      continue;
    }

    const run = runLength(source, i, marker);
    if (run >= count) {
      const before = source[i - 1];
      const after = source[i + count];
      // 閉じる記号の直前は文字であること。_ は語の外側で閉じること。
      const closed =
        before !== undefined && !/\s/.test(before) && (marker !== "_" || after === undefined || !isWordChar(after));
      if (closed) return i;
    }
    i += run;
  }

  return -1;
}

function matchStrike(source: string, start: number): { node: MarkdownInline; end: number } | null {
  const contentStart = start + 2;
  const first = source[contentStart];
  if (first === undefined || /\s/.test(first)) return null;

  const close = source.indexOf("~~", contentStart);
  if (close === -1) return null;

  const text = source.slice(contentStart, close);
  if (text.length === 0 || /\s$/.test(text)) return null;

  return { node: { type: "strike", children: parseInline(text) }, end: close + 2 };
}

type LinkMatch = { label: string; href: string; end: number };

/** [表示](URL) を読む。URL が安全でなければ null（呼び出し側が文字として出す）。 */
function matchLink(source: string, start: number): LinkMatch | null {
  const close = findBracketClose(source, start);
  if (close === -1 || source[close + 1] !== "(") return null;

  const end = findParenClose(source, close + 2);
  if (end === -1) return null;

  const destination = parseDestination(source.slice(close + 2, end));
  if (destination === null) return null;

  const href = safeHref(destination);
  if (href === null) return null;

  return { label: source.slice(start + 1, close), href, end: end + 1 };
}

function findBracketClose(source: string, start: number): number {
  let depth = 0;

  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "[") {
      depth++;
      continue;
    }
    if (char === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** URL の中の括弧は許す（Wikipedia の項目名など）。閉じられていなければ null。 */
function findParenClose(source: string, start: number): number {
  let depth = 1;

  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "\n") return -1;
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** 括弧の中の先頭を URL として読む。後ろに付く題名（"..."）は使わない。 */
function parseDestination(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  if (text.startsWith("<")) {
    const close = text.indexOf(">");
    if (close === -1) return null;
    return text.slice(1, close).trim();
  }

  const space = text.search(/\s/);
  return (space === -1 ? text : text.slice(0, space)).trim();
}

type BareUrl = { href: string; text: string; end: number };

/** 本文にそのまま書かれた URL。文末の句読点は URL に含めない。 */
function matchBareUrl(source: string, start: number): BareUrl | null {
  let end = start;
  while (end < source.length && !/[\s<>]/.test(source[end]!)) end++;

  const text = trimUrlEnd(source.slice(start, end));
  const href = safeHref(text);
  if (href === null) return null;

  return { href, text, end: start + text.length };
}

function trimUrlEnd(url: string): string {
  let text = url;
  while (text.length > 0 && ".,;:!?、。！？".includes(text[text.length - 1]!)) text = text.slice(0, -1);

  // 対応の取れていない閉じ括弧は、URL の一部ではないことが多い。
  while (text.endsWith(")") && countChar(text, "(") < countChar(text, ")")) text = text.slice(0, -1);

  return text;
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const current of text) if (current === char) count++;
  return count;
}

function findCodeSpanClose(source: string, from: number, size: number): number {
  let i = from;

  while (i < source.length) {
    if (source[i] === "`") {
      const run = runLength(source, i, "`");
      if (run === size) return i;
      i += run;
      continue;
    }
    i++;
  }

  return -1;
}

/** コードスパンの前後の 1 つの空白は、飾りとして落とす（` code ` など）。 */
function normalizeCodeSpan(raw: string): string {
  const text = raw.replace(/\n/g, " ");
  if (text.length < 2 || !text.startsWith(" ") || !text.endsWith(" ")) return text;
  if (text.trim().length === 0) return text;
  return text.slice(1, -1);
}

function runLength(source: string, from: number, char: string): number {
  let length = 0;
  while (source[from + length] === char) length++;
  return length;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

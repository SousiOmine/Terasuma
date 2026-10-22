/**
 * 発言の本文を Markdown として解釈する。
 *
 * 画面に出すためだけの、小さな Markdown。CommonMark の全体は実装せず、
 * モデルが実際に書く範囲（見出し・段落・強調・コード・一覧・引用・表）に絞る。
 *
 * 結果は Preact の要素へ写す木で、HTML の文字列は作らない。
 * そのため本文に HTML が混ざっても、タグとして実行されず文字として出る。
 * `javascript:` のような危険な URL も、リンクにせず文字として出す。
 *
 * 閉じていないコードブロックや強調は、入力途中でも画面を壊さないよう、
 * そのままの文字として扱う。
 */

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "break" }
  | { type: "code"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "strike"; children: MarkdownInline[] }
  | { type: "link"; href: string; children: MarkdownInline[] };

export type MarkdownHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** 表の列の揃え。指定が無ければ null（左揃えのまま）。 */
export type MarkdownAlignment = "left" | "center" | "right" | null;

export type MarkdownListItem = {
  /** タスクリスト（- [x]）のときだけ true / false。違うなら null。 */
  checked: boolean | null;
  /** 項目の中身。続きの段落や入れ子の一覧も、同じ項目の blocks として持つ。 */
  blocks: MarkdownBlock[];
};

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "heading"; level: MarkdownHeadingLevel; children: MarkdownInline[] }
  | { type: "code"; text: string }
  | { type: "list"; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: "quote"; children: MarkdownBlock[] }
  | { type: "rule" }
  | { type: "table"; align: MarkdownAlignment[]; header: MarkdownInline[][]; rows: MarkdownInline[][][] };

/** 本文を、画面へ並べられるブロックの列にする。 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

const BLANK = /^\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>/;
const QUOTE_LINE = /^ {0,3}> ?(.*)$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const ESCAPABLE = "\\`*_{}[]()#+-.!<>|~";

/** 行の列を、ブロックの列にする。一覧・引用の中身も同じ関数で読む。 */
function parseBlocks(lines: readonly string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (BLANK.test(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;

      // 閉じる行が無ければ、末尾までをコードとして扱う（書いている途中でも壊さない）。
      while (i < lines.length && !isFenceClose(lines[i]!, marker[0]!, marker.length)) {
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;

      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      // 末尾の # は飾りなので落とす（## 題 ## のような書き方）。
      const text = (heading[2] ?? "").trim().replace(/[ \t]+#+$/, "");
      blocks.push({
        type: "heading",
        level: Number(heading[1]!.length) as MarkdownHeadingLevel,
        children: parseInline(text),
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    const table = tableAt(lines, i);
    if (table !== null) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const match = QUOTE_LINE.exec(current);
        if (match !== null) {
          quoted.push(match[1]!);
          i++;
          continue;
        }
        // 引用の中の空行は、そのあとも引用が続くときだけ残す。
        if (BLANK.test(current) && lines[i + 1] !== undefined && QUOTE.test(lines[i + 1]!)) {
          quoted.push("");
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "quote", children: parseBlocks(quoted) });
      continue;
    }

    if (LIST.exec(line) !== null) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    // 段落。空行か、段落を中断するブロックの手前までを 1 つにまとめる。
    const paragraph: string[] = [];
    while (i < lines.length && !BLANK.test(lines[i]!) && !interruptsParagraph(lines[i]!)) {
      paragraph.push(lines[i]!);
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

/**
 * 一覧 1 つを読む。
 *
 * 項目の続き（深く字下げした行）は、項目の本文の桁まで戻してから、
 * ブロックとして読み直す。こうすると、入れ子の一覧もコードブロックも
 * 同じ仕組みで扱える。
 */
function parseList(lines: readonly string[], start: number): { block: MarkdownBlock; next: number } {
  const first = LIST.exec(lines[start]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /^\d/.test(first[2]!);
  const startNumber = ordered ? Number.parseInt(first[2]!, 10) : 1;

  const items: MarkdownListItem[] = [];
  let current: { lines: string[]; checked: boolean | null } | null = null;
  /** いまの項目の本文が始まる桁。続きの行をここまで戻す。 */
  let contentIndent = baseIndent;

  const flush = (): void => {
    if (current === null) return;

    items.push({ checked: current.checked, blocks: parseBlocks(current.lines) });
    current = null;
  };

  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;

    if (BLANK.test(line)) {
      const next = nextNonBlank(lines, i);
      if (next === null) break;

      const nextLine = lines[next]!;
      const nextMarker = LIST.exec(nextLine);
      const sameItem =
        (nextMarker !== null && nextMarker[1]!.length === baseIndent && isSameListType(nextMarker[2]!, ordered)) ||
        leadingSpaces(nextLine) > baseIndent;
      if (!sameItem) break;

      // 深く字下げした続きがあるなら、空行は項目の中の段落の区切りになる。
      if (current !== null && leadingSpaces(nextLine) > baseIndent) current.lines.push("");
      i++;
      continue;
    }

    const marker = LIST.exec(line);
    if (marker !== null) {
      const indent = marker[1]!.length;

      if (indent === baseIndent) {
        if (!isSameListType(marker[2]!, ordered)) break;

        flush();
        const content = marker[4]!;
        const task = TASK.exec(content);
        current = {
          lines: [task === null ? content : (task[2] ?? "")],
          checked: task === null ? null : task[1] !== " ",
        };
        contentIndent = indent + marker[2]!.length + marker[3]!.length;
        i++;
        continue;
      }

      // 外側の一覧の項目が終わった。深い字下げは、この項目の続きとして読む。
      if (indent < baseIndent) break;
    } else if (leadingSpaces(line) <= baseIndent && interruptsParagraph(line)) {
      break;
    }

    if (current === null) break;

    current.lines.push(stripIndent(line, contentIndent));
    i++;
  }

  flush();

  return { block: { type: "list", ordered, start: startNumber, items }, next: i };
}

/** GFM の表。表の始まりと、読み終わった位置を返す。 */
function tableAt(lines: readonly string[], start: number): { block: MarkdownBlock; next: number } | null {
  const headerLine = lines[start]!;
  const delimiterLine = lines[start + 1];
  if (delimiterLine === undefined || !headerLine.includes("|")) return null;

  const align = parseDelimiterRow(delimiterLine);
  if (align === null || align.length < 2) return null;

  const width = align.length;
  const header = fitCells(splitRow(headerLine), width);
  const rows: MarkdownInline[][][] = [];
  let i = start + 2;

  while (i < lines.length) {
    const line = lines[i]!;
    if (BLANK.test(line) || !line.includes("|")) break;

    rows.push(fitCells(splitRow(line), width).map(parseInline));
    i++;
  }

  return {
    block: { type: "table", align, header: header.map(parseInline), rows },
    next: i,
  };
}

/** 区切りの行（| :--- | ---: |）から、列の揃えを読む。表でなければ null。 */
function parseDelimiterRow(line: string): MarkdownAlignment[] | null {
  const cells = splitRow(line);
  if (cells.length === 0) return null;

  const align: MarkdownAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;

    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }

  return align;
}

/**
 * 表の 1 行をセルに分ける。
 * 行の端の | は空のセルになるので落とし、\| は文字としての | にする。
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());

  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();

  return cells;
}

/** セルの数を列の数に揃える。多い分は捨て、足りない分は空にする。 */
function fitCells(cells: readonly string[], width: number): string[] {
  const fitted = cells.slice(0, width);
  while (fitted.length < width) fitted.push("");
  return fitted;
}

/** 行の先頭の ``` か ~~~ が、開いた囲みを閉じる行かどうか。 */
function isFenceClose(line: string, char: string, size: number): boolean {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  if (i > 3) return false;

  let run = 0;
  while (line[i + run] === char) run++;
  if (run < size) return false;

  let rest = i + run;
  while (rest < line.length && (line[rest] === " " || line[rest] === "\t")) rest++;
  return rest === line.length;
}

/** 段落を中断して、別のブロックを始める行かどうか。 */
function interruptsParagraph(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line);
}

function isSameListType(marker: string, ordered: boolean): boolean {
  return /^\d/.test(marker) === ordered;
}

function nextNonBlank(lines: readonly string[], from: number): number | null {
  for (let i = from; i < lines.length; i++) if (!BLANK.test(lines[i]!)) return i;
  return null;
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (line[count] === " ") count++;
  return count;
}

/** 行頭の空白を、指定した数まで取り除く。 */
function stripIndent(line: string, amount: number): string {
  let remove = 0;
  while (remove < amount && line[remove] === " ") remove++;
  return line.slice(remove);
}

/** 段落・見出し・一覧の項目の中の、1 行分の書き方。 */
function parseInline(source: string): MarkdownInline[] {
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

/**
 * 画面から開いてよい URL だけを返す。
 * http(s) と mailto、このアプリの中のパスだけを許し、それ以外はリンクにしない。
 */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0 || url.startsWith("//")) return null;
  if (/^(?:https?:\/\/|mailto:)/i.test(url) || url.startsWith("/")) return url;
  return null;
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

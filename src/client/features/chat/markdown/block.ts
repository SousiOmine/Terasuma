import { parseInline } from "./inline";
import type { MarkdownAlignment, MarkdownBlock, MarkdownHeadingLevel, MarkdownInline, MarkdownListItem } from "./types";

/**
 * ブロック（見出し・段落・コード・一覧・引用・表・区切り線）の解釈。
 *
 * CommonMark の全体は実装せず、モデルが実際に書く範囲に絞る。
 * 閉じていないコードブロックは、入力の途中でも画面を壊さないよう、そのままの文字として扱う。
 */

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

/** 行の列を、ブロックの列にする。一覧・引用の中身も同じ関数で読む。 */
export function parseBlocks(lines: readonly string[]): MarkdownBlock[] {
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

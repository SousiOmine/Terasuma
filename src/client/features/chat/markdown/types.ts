/**
 * Markdown の解釈結果の型。
 *
 * 画面に並べられるブロックと、その中のインラインの組。HTML の文字列は作らない
 * （本文に HTML が混ざっても、タグとして実行されず文字として出る）。
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

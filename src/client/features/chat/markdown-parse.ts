import { parseBlocks } from "./markdown/block";

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
 * 解釈は ./markdown/ に分かれており、ここは入口だけを持つ。
 */

export type {
  MarkdownAlignment,
  MarkdownBlock,
  MarkdownHeadingLevel,
  MarkdownInline,
  MarkdownListItem,
} from "./markdown/types";
import type { MarkdownBlock } from "./markdown/types";

/** 本文を、画面へ並べられるブロックの列にする。 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

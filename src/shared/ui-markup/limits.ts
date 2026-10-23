/**
 * Tera がチャットへ送る UI のマークアップ。
 *
 * 画面に出すカードを、HTML に似た小さな独自のタグで書く。
 * 見た目は JSX に近いが、HTML としては実行しない。ここに並べたタグだけを解釈し、
 * スクリプト・CSS・イベント属性・URL は受け付けない。
 *
 * 解釈はサーバ（chat_ui ツールの検証）とクライアント（描画）の両方で使う。
 * どちらでも同じ結果になるよう、DOM も Node.js の API も使わない純粋な文字列処理にする。
 */

/**
 * マークアップの上限。
 *
 * モデルが書くものなので、際限なく大きな入力を画面へ流さないよう、ここで必ず止める。
 * 値は「その部品として読める最大量」で決めてある（表のセルや図のノードは、
 * これを超えると画面で読めなくなる）。
 */
export const UI_MARKUP_LIMITS = {
  /** マークアップ全体の長さ（文字数）。 */
  chars: 20_000,
  /** 要素の入れ子の深さ。Card > Form > Field > Option が最大。 */
  depth: 4,
  /** 1 枚のカードに置けるブロックの数。 */
  blocks: 20,
  /** 1 つのカードの見出しの長さ。 */
  titleChars: 200,
  /** 段落 1 つの長さ。 */
  textChars: 4_000,
  /** 1 つの一覧に置ける項目の数。 */
  listItems: 50,
  /** 一覧の項目 1 つの長さ。 */
  listItemChars: 500,
  /** 1 つの表の行の数（1 行目は見出し）。 */
  tableRows: 50,
  /** 1 つの表の列の数。 */
  tableColumns: 8,
  /** 表のセル 1 つの長さ。 */
  tableCellChars: 200,
  /** 1 つのフローチャートのノードの数。 */
  flowNodes: 40,
  /** 1 つのフローチャートの辺の数。 */
  flowEdges: 80,
  /** ノードのラベルの長さ。 */
  flowLabelChars: 60,
  /** 辺のラベルの長さ。 */
  flowEdgeLabelChars: 60,
  /** ノードの id の長さ。 */
  nodeIdChars: 40,
  /** 選択肢の数。 */
  options: 12,
  /** 選択肢のラベルの長さ。 */
  optionLabelChars: 200,
  /** 選択肢の説明の長さ。 */
  optionDescriptionChars: 300,
  /** フォームの入力欄の数。 */
  fields: 12,
  /** 入力欄のラベルの長さ。 */
  fieldLabelChars: 200,
  /** 入力欄の案内文の長さ。 */
  placeholderChars: 200,
  /** 送信ボタンの文言の長さ。 */
  submitChars: 40,
  /** select の選択肢の数。 */
  selectOptions: 30,
} as const;

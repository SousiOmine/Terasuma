/** 段落。改行はそのまま残す。 */
export type UiTextBlock = {
  type: "text";
  text: string;
};

/** 箇条書き。ordered なら番号つき。 */
export type UiListBlock = {
  type: "list";
  ordered: boolean;
  items: readonly string[];
};

/** 表。先頭の行を見出しとして扱う。 */
export type UiTableBlock = {
  type: "table";
  rows: readonly (readonly string[])[];
};

/** フローチャートのノードの形。 */
export type UiFlowShape = "box" | "round" | "diamond" | "pill";

/** フローチャートのノード 1 つ。id は辺の両端を指すために使う。 */
export type UiFlowNode = {
  id: string;
  label: string;
  shape: UiFlowShape;
};

/** フローチャートの辺 1 本。 */
export type UiFlowEdge = {
  from: string;
  to: string;
  label: string | null;
  dashed: boolean;
};

/** フローチャート。ノードの位置は画面が決める（マークアップには書かせない）。 */
export type UiFlowBlock = {
  type: "flow";
  nodes: readonly UiFlowNode[];
  edges: readonly UiFlowEdge[];
};

/** 選択肢 1 つ。 */
export type UiOption = {
  label: string;
  description: string | null;
};

/** 押すとラベルが発言として送られる選択肢。 */
export type UiChoiceBlock = {
  type: "choice";
  multiple: boolean;
  options: readonly UiOption[];
};

/** フォームの入力欄の種類。 */
export type UiFieldType = "text" | "number" | "select" | "checkbox";

/** フォームの入力欄 1 つ。 */
export type UiField = {
  label: string;
  type: UiFieldType;
  required: boolean;
  placeholder: string | null;
  /** type が select のときだけ選択肢を持つ。 */
  options: readonly UiOption[];
};

/** 入力して送信するフォーム。 */
export type UiFormBlock = {
  type: "form";
  submit: string | null;
  fields: readonly UiField[];
};

/** カードに並べるブロック。 */
export type UiBlock = UiTextBlock | UiListBlock | UiTableBlock | UiFlowBlock | UiChoiceBlock | UiFormBlock;

/** カード 1 枚分。 */
export type UiView = {
  title: string | null;
  blocks: readonly UiBlock[];
};

/** 解釈の結果。失敗したときは、直し方（行・桁と理由）を problem に入れる。 */
export type UiParseResult = { ok: true; view: UiView } | { ok: false; problem: string };

/** 押すと発言を送るブロック（Choice / Form）。無ければ null。 */
export function interactiveBlock(view: UiView): UiChoiceBlock | UiFormBlock | null {
  for (const block of view.blocks) {
    if (block.type === "choice" || block.type === "form") return block;
  }
  return null;
}

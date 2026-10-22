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

/** 解釈の途中で見つかった、直せない書き方。位置は文字列の添字で持つ。 */
class MarkupError extends Error {
  readonly at: number;

  constructor(at: number, message: string) {
    super(message);
    this.name = "MarkupError";
    this.at = at;
  }
}

/** タグに書かれていた属性 1 つ。値の無い真偽属性は value が null。 */
type RawAttribute = {
  name: string;
  value: string | null;
  at: number;
};

/** タグの中身。テキストか、子の要素。 */
type RawChild = { kind: "text"; text: string; at: number } | RawElement;

/** 文法を確かめる前の、タグの木。 */
type RawElement = {
  kind: "element";
  name: string;
  attrs: RawAttribute[];
  children: RawChild[];
  at: number;
};

const BLOCK_TAGS = ["Text", "List", "Table", "Flow", "Choice", "Form"] as const;
const ALL_TAGS = ["Card", ...BLOCK_TAGS, "Item", "Row", "Cell", "Node", "Edge", "Option", "Field"] as const;

/** カードのマークアップを解釈する。失敗しても投げず、理由を返す。 */
export function parseUiMarkup(source: string): UiParseResult {
  const text = source.replace(/\r\n/g, "\n");
  if (text.trim().length === 0) return { ok: false, problem: "the markup is empty; it needs one <Card>" };
  if (text.length > UI_MARKUP_LIMITS.chars) {
    return {
      ok: false,
      problem: `the markup is ${text.length} characters; the limit is ${UI_MARKUP_LIMITS.chars}`,
    };
  }

  try {
    const root = new MarkupReader(text).readDocument();
    return { ok: true, view: buildView(root) };
  } catch (error) {
    if (!(error instanceof MarkupError)) throw error;
    const { line, column } = positionOf(text, error.at);
    return { ok: false, problem: `line ${line}, column ${column}: ${error.message}` };
  }
}

/**
 * 文字列を、タグとテキストの木へほどく。
 * どのタグがどこに置けるかは buildView が確かめる（ここは形だけを見る）。
 */
class MarkupReader {
  private index = 0;

  constructor(private readonly source: string) {}

  readDocument(): RawElement {
    this.skipSpace();
    if (this.source[this.index] === undefined) this.bad("the markup is empty; it needs one <Card>");
    if (this.source[this.index] !== "<") this.bad("the markup must start with <Card>");

    const root = this.readElement(1);
    this.skipSpace();
    if (this.index < this.source.length) this.bad("unexpected text after the closing </Card>");
    return root;
  }

  private readElement(depth: number): RawElement {
    const at = this.index;
    if (depth > UI_MARKUP_LIMITS.depth) {
      this.bad(`elements are nested deeper than ${UI_MARKUP_LIMITS.depth} levels`, at);
    }

    this.index += 1; // "<"
    if (this.source[this.index] === "/") this.bad("unexpected closing tag", at);
    if (this.source[this.index] === "!") this.bad("comments and declarations are not supported", at);

    const name = this.readName();
    const attrs: RawAttribute[] = [];

    for (;;) {
      this.skipSpace();
      const char = this.source[this.index];
      if (char === undefined) this.bad(`tag <${name}> is not closed`, at);

      if (char === ">") {
        this.index += 1;
        break;
      }
      if (char === "/") {
        if (this.source[this.index + 1] !== ">") this.bad('expected "/>" to close the tag');
        this.index += 2;
        return { kind: "element", name, attrs, children: [], at };
      }
      attrs.push(this.readAttribute());
    }

    return { kind: "element", name, attrs, children: this.readChildren(name, depth, at), at };
  }

  private readChildren(name: string, depth: number, at: number): RawChild[] {
    const children: RawChild[] = [];

    for (;;) {
      const char = this.source[this.index];
      if (char === undefined) this.bad(`tag <${name}> is not closed with </${name}>`, at);

      if (char === "<") {
        if (this.source[this.index + 1] === "/") {
          const closeAt = this.index;
          this.index += 2;
          const closing = this.readName();
          if (closing !== name) this.bad(`expected </${name}> but found </${closing}>`, closeAt);
          this.skipSpace();
          if (this.source[this.index] !== ">") this.bad('expected ">" to close the tag', closeAt);
          this.index += 1;
          return children;
        }
        if (this.source[this.index + 1] === "!") this.bad("comments and declarations are not supported");
        // 文章の中の "<" はタグの始まりと区別できない。書くときは実体参照にする。
        if (!isLetter(this.source[this.index + 1])) {
          this.bad('write "<" in text as &lt;, or close the tag with "/>"');
        }
        children.push(this.readElement(depth + 1));
        continue;
      }

      const textAt = this.index;
      this.index += 1;
      while (this.source[this.index] !== undefined && this.source[this.index] !== "<") this.index += 1;
      children.push({
        kind: "text",
        text: decodeEntities(this.source.slice(textAt, this.index), textAt),
        at: textAt,
      });
    }
  }

  private readName(): string {
    const start = this.index;
    if (!isLetter(this.source[this.index])) this.bad("expected a tag name");
    while (isNameChar(this.source[this.index])) this.index += 1;
    return this.source.slice(start, this.index);
  }

  private readAttribute(): RawAttribute {
    const at = this.index;
    if (!isLetter(this.source[this.index])) this.bad("expected an attribute name");

    const start = this.index;
    while (isAttributeChar(this.source[this.index])) this.index += 1;
    const name = this.source.slice(start, this.index);

    this.skipSpace();
    let value: string | null = null;
    if (this.source[this.index] === "=") {
      this.index += 1;
      this.skipSpace();
      if (this.source[this.index] !== '"') this.bad(`attribute "${name}" must use double quotes`);
      this.index += 1;

      const valueAt = this.index;
      while (this.source[this.index] !== undefined && this.source[this.index] !== '"') this.index += 1;
      if (this.source[this.index] === undefined) this.bad(`attribute "${name}" is not closed`, at);
      value = decodeEntities(this.source.slice(valueAt, this.index), valueAt);
      this.index += 1;
    }

    return { name, value, at };
  }

  private skipSpace(): void {
    while (isSpace(this.source[this.index])) this.index += 1;
  }

  private bad(message: string, at = this.index): never {
    fail(at, message);
  }
}

/** 文法の誤りを、位置（文字列の添字）つきで投げる。 */
function fail(at: number, message: string): never {
  throw new MarkupError(at, message);
}

/** タグの木を、文法に沿ったカードへ組み直す。 */
function buildView(root: RawElement): UiView {
  if (root.name !== "Card") fail(root.at, `the root must be <Card>, not <${root.name}>`);

  checkAttributes(root, ["title"]);
  const title = stringAttribute(root, "title", UI_MARKUP_LIMITS.titleChars);

  const nodes = elementChildren(root, BLOCK_TAGS);
  if (nodes.length === 0) fail(root.at, "<Card> needs at least one block");
  if (nodes.length > UI_MARKUP_LIMITS.blocks) {
    fail(root.at, `<Card> has ${nodes.length} blocks; the limit is ${UI_MARKUP_LIMITS.blocks}`);
  }

  const blocks = nodes.map(buildBlock);
  const interactive = blocks.filter((block) => block.type === "choice" || block.type === "form").length;
  if (interactive > 1) fail(root.at, "a card can have at most one <Choice> or <Form>");

  return { title, blocks };
}

function buildBlock(node: RawElement): UiBlock {
  switch (node.name) {
    case "Text":
      checkAttributes(node, []);
      return { type: "text", text: textContent(node, UI_MARKUP_LIMITS.textChars, "the text") };

    case "List":
      return buildList(node);

    case "Table":
      return buildTable(node);

    case "Flow":
      return buildFlow(node);

    case "Choice":
      return buildChoice(node);

    case "Form":
      return buildForm(node);

    default:
      fail(node.at, `unknown tag <${node.name}> (allowed: ${ALL_TAGS.join(", ")})`);
  }
}

function buildList(node: RawElement): UiListBlock {
  checkAttributes(node, ["ordered"]);
  const ordered = flagAttribute(node, "ordered");
  const items = elementChildren(node, ["Item"]).map((item) => {
    checkAttributes(item, []);
    return textContent(item, UI_MARKUP_LIMITS.listItemChars, "a list item");
  });

  if (items.length === 0) fail(node.at, "<List> needs at least one <Item>");
  if (items.length > UI_MARKUP_LIMITS.listItems) {
    fail(node.at, `<List> has ${items.length} items; the limit is ${UI_MARKUP_LIMITS.listItems}`);
  }

  return { type: "list", ordered, items };
}

function buildTable(node: RawElement): UiTableBlock {
  checkAttributes(node, []);

  const rows = elementChildren(node, ["Row"]).map((row) => {
    checkAttributes(row, []);
    const cells = elementChildren(row, ["Cell"]).map((cell) => {
      checkAttributes(cell, []);
      return textContent(cell, UI_MARKUP_LIMITS.tableCellChars, "a table cell");
    });
    return { at: row.at, cells };
  });

  if (rows.length === 0) fail(node.at, "<Table> needs at least one <Row>");
  if (rows.length > UI_MARKUP_LIMITS.tableRows) {
    fail(node.at, `<Table> has ${rows.length} rows; the limit is ${UI_MARKUP_LIMITS.tableRows}`);
  }

  const first = rows[0];
  if (first === undefined) fail(node.at, "<Table> needs at least one <Row>");
  const columns = first.cells.length;
  if (columns === 0) fail(first.at, "<Row> needs at least one <Cell>");
  if (columns > UI_MARKUP_LIMITS.tableColumns) {
    fail(first.at, `a row has ${columns} cells; the limit is ${UI_MARKUP_LIMITS.tableColumns}`);
  }

  for (const row of rows) {
    if (row.cells.length !== columns) {
      fail(row.at, `every row needs ${columns} cells, but this row has ${row.cells.length}`);
    }
  }

  return { type: "table", rows: rows.map((row) => row.cells) };
}

function buildFlow(node: RawElement): UiFlowBlock {
  checkAttributes(node, []);

  const nodes: UiFlowNode[] = [];
  const edges: { at: number; edge: UiFlowEdge }[] = [];

  for (const element of elementChildren(node, ["Node", "Edge"])) {
    if (element.name === "Node") {
      nodes.push(readFlowNode(element, nodes));
      continue;
    }
    edges.push(readFlowEdge(element));
  }

  if (nodes.length === 0) fail(node.at, "<Flow> needs at least one <Node>");
  if (nodes.length > UI_MARKUP_LIMITS.flowNodes) {
    fail(node.at, `<Flow> has ${nodes.length} nodes; the limit is ${UI_MARKUP_LIMITS.flowNodes}`);
  }
  if (edges.length > UI_MARKUP_LIMITS.flowEdges) {
    fail(node.at, `<Flow> has ${edges.length} edges; the limit is ${UI_MARKUP_LIMITS.flowEdges}`);
  }

  const ids = new Set(nodes.map((entry) => entry.id));
  for (const { at, edge } of edges) {
    if (!ids.has(edge.from)) fail(at, `the edge refers to the unknown node "${edge.from}"`);
    if (!ids.has(edge.to)) fail(at, `the edge refers to the unknown node "${edge.to}"`);
  }

  return { type: "flow", nodes, edges: edges.map((entry) => entry.edge) };
}

function readFlowNode(node: RawElement, nodes: readonly UiFlowNode[]): UiFlowNode {
  checkAttributes(node, ["id", "shape"]);

  const id = requiredAttribute(node, "id", UI_MARKUP_LIMITS.nodeIdChars);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    fail(node.at, `the node id "${id}" must use letters, digits, "_" or "-"`);
  }
  if (nodes.some((other) => other.id === id)) fail(node.at, `the node id "${id}" is used twice`);

  const shape = flowShape(node);
  const label = textContent(node, UI_MARKUP_LIMITS.flowLabelChars, `the label of node "${id}"`);
  return { id, label, shape };
}

function flowShape(node: RawElement): UiFlowShape {
  const value = stringAttribute(node, "shape", 20);
  if (value === null) return "box";
  if (value === "box" || value === "round" || value === "diamond" || value === "pill") return value;
  fail(node.at, `unknown shape "${value}" (use box, round, diamond or pill)`);
}

function readFlowEdge(node: RawElement): { at: number; edge: UiFlowEdge } {
  checkAttributes(node, ["from", "to", "label", "dashed"]);
  noContent(node);

  const from = requiredAttribute(node, "from", UI_MARKUP_LIMITS.nodeIdChars);
  const to = requiredAttribute(node, "to", UI_MARKUP_LIMITS.nodeIdChars);
  if (from === to) fail(node.at, "an <Edge> must connect two different nodes");

  const label = stringAttribute(node, "label", UI_MARKUP_LIMITS.flowEdgeLabelChars);
  return { at: node.at, edge: { from, to, label, dashed: flagAttribute(node, "dashed") } };
}

function buildChoice(node: RawElement): UiChoiceBlock {
  checkAttributes(node, ["multiple"]);
  const multiple = flagAttribute(node, "multiple");
  const options = readOptions(node);

  if (options.length < 2) fail(node.at, "<Choice> needs at least two <Option>");
  if (options.length > UI_MARKUP_LIMITS.options) {
    fail(node.at, `<Choice> has ${options.length} options; the limit is ${UI_MARKUP_LIMITS.options}`);
  }

  return { type: "choice", multiple, options };
}

function buildForm(node: RawElement): UiFormBlock {
  checkAttributes(node, ["submit"]);
  const submit = stringAttribute(node, "submit", UI_MARKUP_LIMITS.submitChars);
  const fields = elementChildren(node, ["Field"]).map(readField);

  if (fields.length === 0) fail(node.at, "<Form> needs at least one <Field>");
  if (fields.length > UI_MARKUP_LIMITS.fields) {
    fail(node.at, `<Form> has ${fields.length} fields; the limit is ${UI_MARKUP_LIMITS.fields}`);
  }

  return { type: "form", submit, fields };
}

function readField(node: RawElement): UiField {
  checkAttributes(node, ["label", "type", "required", "placeholder"]);

  const label = requiredAttribute(node, "label", UI_MARKUP_LIMITS.fieldLabelChars);
  const type = fieldType(node);
  const required = flagAttribute(node, "required");
  const placeholder = stringAttribute(node, "placeholder", UI_MARKUP_LIMITS.placeholderChars);

  if (type === "select") {
    const options = readOptions(node);
    if (options.length === 0) fail(node.at, '<Field type="select"> needs at least one <Option>');
    if (options.length > UI_MARKUP_LIMITS.selectOptions) {
      fail(node.at, `<Field> has ${options.length} options; the limit is ${UI_MARKUP_LIMITS.selectOptions}`);
    }
    return { label, type, required, placeholder, options };
  }

  noContent(node);
  return { label, type, required, placeholder, options: [] };
}

function fieldType(node: RawElement): UiFieldType {
  const value = stringAttribute(node, "type", 20);
  if (value === null) return "text";
  if (value === "text" || value === "number" || value === "select" || value === "checkbox") return value;
  fail(node.at, `unknown field type "${value}" (use text, number, select or checkbox)`);
}

function readOptions(node: RawElement): UiOption[] {
  return elementChildren(node, ["Option"]).map((option) => {
    checkAttributes(option, ["description"]);
    return {
      label: textContent(option, UI_MARKUP_LIMITS.optionLabelChars, "an option label"),
      description: stringAttribute(option, "description", UI_MARKUP_LIMITS.optionDescriptionChars),
    };
  });
}

/** そのタグが受け付ける属性を確かめる。 */
function checkAttributes(node: RawElement, allowed: readonly string[]): void {
  for (const attribute of node.attrs) {
    if (allowed.includes(attribute.name)) continue;

    const hint = allowed.length === 0 ? "it takes no attributes" : `allowed: ${allowed.join(", ")}`;
    fail(attribute.at, `<${node.name}> does not take the attribute "${attribute.name}" (${hint})`);
  }
}

/** 値つきの属性。書かれていなければ null。 */
function stringAttribute(node: RawElement, name: string, maxChars: number): string | null {
  const attribute = node.attrs.find((entry) => entry.name === name);
  if (attribute === undefined) return null;
  if (attribute.value === null) {
    fail(attribute.at, `attribute "${name}" of <${node.name}> needs a value in double quotes`);
  }

  const value = attribute.value.trim();
  if (value.length === 0) fail(attribute.at, `attribute "${name}" of <${node.name}> is empty`);
  if (value.length > maxChars) {
    fail(attribute.at, `attribute "${name}" is ${value.length} characters; the limit is ${maxChars}`);
  }
  return value;
}

/** 値なしの真偽属性。 */
function flagAttribute(node: RawElement, name: string): boolean {
  const attribute = node.attrs.find((entry) => entry.name === name);
  if (attribute === undefined) return false;
  if (attribute.value !== null) fail(attribute.at, `attribute "${name}" of <${node.name}> takes no value`);
  return true;
}

/** 必ず書く値つきの属性。 */
function requiredAttribute(node: RawElement, name: string, maxChars: number): string {
  const value = stringAttribute(node, name, maxChars);
  if (value === null) fail(node.at, `<${node.name}> needs the attribute "${name}"`);
  return value;
}

/** タグの中のテキストだけを取り出す。要素が混ざっていれば、その位置で断る。 */
function textContent(node: RawElement, maxChars: number, what: string): string {
  let raw = "";
  for (const child of node.children) {
    if (child.kind === "element") {
      fail(child.at, `<${node.name}> can only contain text; <${child.name}> is not allowed inside it`);
    }
    raw += child.text;
  }

  const text = normalizeText(raw);
  if (text.length === 0) fail(node.at, `${what} is empty`);
  if (text.length > maxChars) fail(node.at, `${what} is ${text.length} characters; the limit is ${maxChars}`);
  return text;
}

/** 子の要素だけを取り出し、囲みの中のテキストや知らないタグを断る。 */
function elementChildren(node: RawElement, allowed: readonly string[]): RawElement[] {
  const elements: RawElement[] = [];

  for (const child of node.children) {
    if (child.kind === "text") {
      if (child.text.trim().length === 0) continue;
      const hint = allowed[0] === undefined ? "" : `; use <${allowed[0]}>`;
      fail(child.at, `text is not allowed directly inside <${node.name}>${hint}`);
    }
    if (!allowed.includes(child.name)) {
      const hint = allowed.length === 0 ? "" : ` (allowed: ${allowed.join(", ")})`;
      fail(child.at, `<${child.name}> is not allowed inside <${node.name}>${hint}`);
    }
    elements.push(child);
  }

  return elements;
}

/** 子を持つはずのないタグ（Edge など）。 */
function noContent(node: RawElement): void {
  for (const child of node.children) {
    if (child.kind === "element") fail(child.at, `<${node.name}> has no child elements`);
    if (child.text.trim().length > 0) fail(child.at, `<${node.name}> has no content`);
  }
}

/**
 * タグの中のテキストを整える。
 * 前後の空白と、行頭の共通のインデント（マークアップを字下げして書いた分）を落とす。
 */
function normalizeText(raw: string): string {
  const lines = raw.split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim().length === 0) lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length === 0) lines.pop();
  if (lines.length === 0) return "";

  let indent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }

  const dedented = lines.map((line) => (line.trim().length === 0 ? "" : line.slice(indent)));
  return dedented.join("\n").trim();
}

/** 文字列の添字を、行と桁に直す。 */
function positionOf(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;

  const end = Math.min(index, source.length);
  for (let cursor = 0; cursor < end; cursor += 1) {
    if (source[cursor] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

/** 実体参照。5 つだけを受け付ける。 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** テキストと属性値の実体参照をほどく。知らない書き方は、その位置で断る。 */
function decodeEntities(raw: string, at: number): string {
  if (!raw.includes("&")) return raw;

  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (char !== "&") {
      out += char;
      continue;
    }

    const match = /^&([a-z]+);/.exec(raw.slice(index));
    if (match === null) {
      fail(at + index, 'write "&" as &amp; and use one of &lt; &gt; &amp; &quot; &apos;');
    }

    const name = match[1] ?? "";
    const decoded = ENTITIES[name];
    if (decoded === undefined) {
      fail(at + index, `unknown entity "&${name};" (use &lt; &gt; &amp; &quot; &apos;)`);
    }
    out += decoded;
    index += match[0].length - 1;
  }

  return out;
}

function isSpace(value: string | undefined): boolean {
  return value === " " || value === "\n" || value === "\t" || value === "\r";
}

function isLetter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z]/.test(value);
}

function isNameChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9]/.test(value);
}

function isAttributeChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9-]/.test(value);
}

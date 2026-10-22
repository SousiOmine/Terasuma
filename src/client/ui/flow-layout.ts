import type { UiFlowBlock, UiFlowEdge, UiFlowNode, UiFlowShape } from "../../shared/ui-markup";

/**
 * フローチャートのレイアウト。
 *
 * ノードの位置は画面が決める（マークアップには書かせない）。
 * 上から下へ流れる層状の配置にして、辺の交差が少なくなるよう並べ替える。
 * 閉路を閉じる「戻る辺」は右側へ回す。
 *
 * DOM も測量も使わない純粋な計算にしてある。文字幅は全角・半角の目安で数え、
 * 同じ入力からは必ず同じ配置になる。
 */

/** ノードの幅。形によらず揃える（層の中央寄せが単純になる）。 */
const NODE_WIDTH = 168;

/** ノードの最小の高さ。 */
const MIN_NODE_HEIGHT = 40;

/** ノードの内側の余白。 */
const NODE_PADDING_X = 12;
const NODE_PADDING_Y = 10;

/** 文字 1 行の高さ。描画側も、行の位置を決めるのに使う。 */
export const FLOW_LINE_HEIGHT = 16;

/** 全体の余白。 */
const PADDING = 16;

/** 層と層の間。辺のラベルが入る余白でもある。 */
const RANK_GAP = 56;

/** 同じ層に並ぶノードの間。 */
const SIBLING_GAP = 24;

/** 戻る辺を右へ逃がす量。 */
const BACK_EDGE_GAP = 28;

/** 戻る辺どうしの間隔。 */
const BACK_EDGE_STEP = 14;

/** ラベルの折り返しに使う 1 文字の幅。全角は 12、半角は 6.4 として数える。 */
const WIDE_CHAR_WIDTH = 12;
const NARROW_CHAR_WIDTH = 6.4;

/** 画面に置くノード 1 つ。 */
export type FlowNodeBox = {
  id: string;
  label: string;
  /** 折り返した後の行。 */
  lines: readonly string[];
  shape: UiFlowShape;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 画面に引く辺 1 本。 */
export type FlowEdgeLine = {
  from: string;
  to: string;
  label: string | null;
  dashed: boolean;
  /** SVG の path の d。 */
  path: string;
  labelX: number;
  labelY: number;
};

/** 図全体の大きさと、置くもの。 */
export type FlowLayout = {
  width: number;
  height: number;
  nodes: readonly FlowNodeBox[];
  edges: readonly FlowEdgeLine[];
};

/** 図のノードと辺から、画面に置く位置を決める。 */
export function layoutFlow(block: UiFlowBlock): FlowLayout {
  const back = backEdges(block);
  const rank = ranks(block, back);
  const layers = orderLayers(block, rank, back);

  // 戻る辺は右側に回すので、その分の余白を両側に足す（図の中央は動かさない）。
  const backMargin = back.size === 0 ? 0 : BACK_EDGE_GAP + back.size * BACK_EDGE_STEP + 12;
  const sidePadding = PADDING + backMargin;

  // 1 回目: 折り返しを含めたノードの高さを測る。
  const sizes = new Map(block.nodes.map((node) => [node.id, measure(node)]));

  // 2 回目: 一番広い層に合わせて、図の幅を決める。
  let contentWidth = 0;
  for (const layer of layers) contentWidth = Math.max(contentWidth, layerWidth(layer.length));
  const width = contentWidth + sidePadding * 2;

  const nodes: FlowNodeBox[] = [];
  const boxes = new Map<string, FlowNodeBox>();

  let y = PADDING;
  for (const layer of layers) {
    let rowHeight = 0;
    for (const id of layer) rowHeight = Math.max(rowHeight, sizes.get(id)?.height ?? MIN_NODE_HEIGHT);

    let x = (width - layerWidth(layer.length)) / 2;
    for (const id of layer) {
      const node = block.nodes.find((entry) => entry.id === id);
      const size = sizes.get(id);
      if (node === undefined || size === undefined) continue;

      const box: FlowNodeBox = {
        id,
        label: node.label,
        lines: size.lines,
        shape: node.shape,
        x,
        y,
        width: NODE_WIDTH,
        height: size.height,
      };
      nodes.push(box);
      boxes.set(id, box);
      x += NODE_WIDTH + SIBLING_GAP;
    }

    y += rowHeight + RANK_GAP;
  }

  const height = y - RANK_GAP + PADDING;
  const edges: FlowEdgeLine[] = [];
  let backIndex = 0;

  for (const edge of block.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (from === undefined || to === undefined) continue;

    if (back.has(edge)) {
      edges.push(backEdgeLine(edge, from, to, backIndex));
      backIndex += 1;
      continue;
    }
    edges.push(forwardEdgeLine(edge, from, to));
  }

  return { width, height, nodes, edges };
}

/** 1 つの層に並ぶノードの幅。 */
function layerWidth(count: number): number {
  return count * NODE_WIDTH + Math.max(0, count - 1) * SIBLING_GAP;
}

/** ノードの大きさと、折り返したラベルを決める。 */
function measure(node: UiFlowNode): { lines: string[]; height: number } {
  // ひし形は文字を置ける幅が狭いので、短めに折り返す。
  const textWidth = node.shape === "diamond" ? NODE_WIDTH - 72 : NODE_WIDTH - NODE_PADDING_X * 2;
  const lines = wrap(node.label, textWidth);
  const height = Math.max(MIN_NODE_HEIGHT, lines.length * FLOW_LINE_HEIGHT + NODE_PADDING_Y * 2);
  return { lines, height };
}

/** ラベルを、文字幅の目安で折り返す。改行はそのまま活かす。 */
function wrap(label: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  let width = 0;

  for (const char of label) {
    if (char === "\n") {
      lines.push(current);
      current = "";
      width = 0;
      continue;
    }

    const charWidth = widthOf(char);
    if (width + charWidth > maxWidth && current.length > 0) {
      lines.push(current);
      current = "";
      width = 0;
    }

    current += char;
    width += charWidth;
  }

  lines.push(current);
  return lines;
}

/** 1 文字のおおよその幅。日本語などの全角を広く見る。 */
function widthOf(char: string): number {
  return (char.codePointAt(0) ?? 0) >= 0x2e80 ? WIDE_CHAR_WIDTH : NARROW_CHAR_WIDTH;
}

/**
 * 閉路を閉じる辺（戻る辺）を見つける。
 * 深さ優先で辿り、いま辿っている途中のノードへ戻る辺を戻る辺とする。
 * これを取り除けば、残りは必ず上から下へ流れる DAG になる。
 */
function backEdges(block: UiFlowBlock): ReadonlySet<UiFlowEdge> {
  const back = new Set<UiFlowEdge>();
  const state = new Map<string, 0 | 1 | 2>();

  const visit = (id: string): void => {
    state.set(id, 1);

    for (const edge of block.edges) {
      if (edge.from !== id) continue;

      const next = state.get(edge.to) ?? 0;
      if (next === 1) {
        back.add(edge);
        continue;
      }
      if (next === 0) visit(edge.to);
    }

    state.set(id, 2);
  };

  for (const node of block.nodes) {
    if ((state.get(node.id) ?? 0) === 0) visit(node.id);
  }

  return back;
}

/**
 * ノードを上から下の層へ分ける。
 * 戻る辺を除いた DAG の上で、入口から一番遠い距離を層の番号にする（最長経路）。
 */
function ranks(block: UiFlowBlock, back: ReadonlySet<UiFlowEdge>): Map<string, number> {
  const forward = block.edges.filter((edge) => !back.has(edge));
  const rank = new Map(block.nodes.map((node) => [node.id, 0]));
  const incoming = new Map(block.nodes.map((node) => [node.id, 0]));

  for (const edge of forward) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  const queue = block.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined) continue;

    for (const edge of forward) {
      if (edge.from !== id) continue;

      const next = (rank.get(id) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0)) rank.set(edge.to, next);

      const remaining = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }

  return rank;
}

/**
 * 層の中の並び順を決める。
 * 隣の層とのつながりの重心へ寄せる操作を上下に数回くり返し、辺の交差を減らす。
 * つながりの無いノードは、元の順のまま末尾に残す。
 */
function orderLayers(block: UiFlowBlock, rank: ReadonlyMap<string, number>, back: ReadonlySet<UiFlowEdge>): string[][] {
  const layers: string[][] = [];
  for (const node of block.nodes) {
    const level = rank.get(node.id) ?? 0;
    const layer = layers[level];
    if (layer === undefined) {
      layers[level] = [node.id];
    } else {
      layer.push(node.id);
    }
  }

  const position = new Map<string, number>();
  const remember = (): void => {
    for (const layer of layers) {
      layer.forEach((id, index) => {
        position.set(id, index);
      });
    }
  };
  remember();

  const neighborsOf = (id: string, side: "in" | "out"): string[] => {
    const ids: string[] = [];
    for (const edge of block.edges) {
      if (back.has(edge)) continue;
      if (side === "in" && edge.to === id) ids.push(edge.from);
      if (side === "out" && edge.from === id) ids.push(edge.to);
    }
    return ids;
  };

  const sortLayer = (layer: string[], side: "in" | "out"): void => {
    const center = new Map<string, number>();
    for (const id of layer) {
      const adjacent = neighborsOf(id, side).filter((other) => position.has(other));
      center.set(
        id,
        adjacent.length === 0
          ? Number.POSITIVE_INFINITY
          : adjacent.reduce((sum, other) => sum + (position.get(other) ?? 0), 0) / adjacent.length,
      );
    }

    const before = new Map(layer.map((id, index) => [id, index]));
    layer.sort(
      (left, right) =>
        (center.get(left) ?? 0) - (center.get(right) ?? 0) || (before.get(left) ?? 0) - (before.get(right) ?? 0),
    );
    layer.forEach((id, index) => {
      position.set(id, index);
    });
  };

  for (let round = 0; round < 4; round += 1) {
    for (let level = 1; level < layers.length; level += 1) {
      const layer = layers[level];
      if (layer !== undefined) sortLayer(layer, "in");
    }
    for (let level = layers.length - 2; level >= 0; level -= 1) {
      const layer = layers[level];
      if (layer !== undefined) sortLayer(layer, "out");
    }
  }

  return layers;
}

/** 上から下へ流れる辺。下辺の中央から上辺の中央へ、縦向きの曲線で結ぶ。 */
function forwardEdgeLine(edge: UiFlowEdge, from: FlowNodeBox, to: FlowNodeBox): FlowEdgeLine {
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height;
  const endX = to.x + to.width / 2;
  const endY = to.y;
  const middleY = (startY + endY) / 2;

  return {
    from: edge.from,
    to: edge.to,
    label: edge.label,
    dashed: edge.dashed,
    path: `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2,
    labelY: middleY,
  };
}

/** 戻る辺。右側へ回り込ませ、辺どうしが重ならないよう少しずつ外へずらす。 */
function backEdgeLine(edge: UiFlowEdge, from: FlowNodeBox, to: FlowNodeBox, index: number): FlowEdgeLine {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width;
  const endY = to.y + to.height / 2;
  const controlX = Math.max(startX, endX) + BACK_EDGE_GAP + index * BACK_EDGE_STEP;

  return {
    from: edge.from,
    to: edge.to,
    label: edge.label,
    dashed: edge.dashed,
    path: `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`,
    // 3 次ベジェの t=0.5 の位置。
    labelX: (startX + endX + controlX * 6) / 8,
    labelY: (startY + endY) / 2,
  };
}

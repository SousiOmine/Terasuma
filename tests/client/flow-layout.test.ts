import { describe, expect, test } from "bun:test";
import type { FlowLayout, FlowNodeBox } from "../../src/client/ui/flow-layout";
import { layoutFlow } from "../../src/client/ui/flow-layout";
import type { UiFlowBlock } from "../../src/shared/ui-markup";

/**
 * フローチャートの配置。
 * 位置は DOM を使わずに決まるので、重なりと向きだけを機械的に確かめる。
 */

function block(nodes: UiFlowBlock["nodes"], edges: UiFlowBlock["edges"]): UiFlowBlock {
  return { type: "flow", nodes, edges };
}

function node(id: string, label = id, shape: UiFlowBlock["nodes"][number]["shape"] = "box") {
  return { id, label, shape };
}

function edge(from: string, to: string) {
  return { from, to, label: null, dashed: false };
}

function boxOf(layout: FlowLayout, id: string): FlowNodeBox {
  const box = layout.nodes.find((node) => node.id === id);
  if (box === undefined) throw new Error(`ノード ${id} が無い`);
  return box;
}

function overlaps(left: FlowNodeBox, right: FlowNodeBox): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

function expectNoOverlap(layout: FlowLayout): void {
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      const left = layout.nodes[i];
      const right = layout.nodes[j];
      if (left === undefined || right === undefined) continue;

      expect(overlaps(left, right), `${left.id} と ${right.id} が重なっている`).toBe(false);
    }
  }
}

describe("フローチャートの配置", () => {
  test("上から下へ層を分け、辺を結ぶ", () => {
    const layout = layoutFlow(block([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c")]));

    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    expect(boxOf(layout, "a").y).toBeLessThan(boxOf(layout, "b").y);
    expect(boxOf(layout, "b").y).toBeLessThan(boxOf(layout, "c").y);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.edges.every((line) => line.path.startsWith("M ") && line.path.includes(" C "))).toBe(true);
  });

  test("分かれる図でも、ノードは重ならない", () => {
    const layout = layoutFlow(
      block(
        [node("a"), node("b"), node("c"), node("d", "終了", "pill")],
        [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
      ),
    );

    expectNoOverlap(layout);
    // 分かれた 2 つは同じ層に並ぶ。
    expect(boxOf(layout, "b").y).toBe(boxOf(layout, "c").y);
  });

  test("長いラベルは折り返し、ノードが高くなる", () => {
    const short = layoutFlow(block([node("a", "短い")], []));
    const long = layoutFlow(block([node("a", "これはとても長いラベルなので、いくつもの行に折り返されます")], []));

    expect(boxOf(short, "a").lines).toEqual(["短い"]);
    expect(boxOf(long, "a").lines.length).toBeGreaterThan(1);
    expect(boxOf(long, "a").height).toBeGreaterThan(boxOf(short, "a").height);
  });

  test("改行はそのまま行になる", () => {
    const layout = layoutFlow(block([node("a", "1 行目\n2 行目")], []));

    expect(boxOf(layout, "a").lines).toEqual(["1 行目", "2 行目"]);
  });

  test("ループ（戻る辺）も右へ回して描く", () => {
    const layout = layoutFlow(
      block([node("a"), node("b")], [edge("a", "b"), { from: "b", to: "a", label: "やり直す", dashed: true }]),
    );

    expect(layout.edges).toHaveLength(2);
    expectNoOverlap(layout);

    const back = layout.edges.find((line) => line.from === "b" && line.to === "a");
    if (back === undefined) throw new Error("戻る辺が無い");

    // 図の幅に収まっている（右へはみ出したまま切れない）。
    expect(back.labelX).toBeGreaterThan(0);
    expect(back.labelX).toBeLessThan(layout.width);
    expect(layout.nodes.every((box) => Number.isFinite(box.x) && Number.isFinite(box.y))).toBe(true);
  });

  test("多くのノードでも重ならず、同じ入力からは同じ配置になる", () => {
    const nodes = Array.from({ length: 12 }, (_, index) => node(`n${index}`));
    const edges = nodes.slice(1).map((entry, index) => edge(`n${index}`, entry.id));
    const graph = block(nodes, edges);

    const first = layoutFlow(graph);
    const second = layoutFlow(graph);

    expect(first).toEqual(second);
    expectNoOverlap(first);
    expect(first.nodes).toHaveLength(12);
  });

  test("ノード 1 つでも、余白を含めた大きさになる", () => {
    const layout = layoutFlow(block([node("only", "開始", "round")], []));
    const box = boxOf(layout, "only");

    expect(layout.width).toBeGreaterThan(box.width);
    expect(layout.height).toBeGreaterThan(box.height);
    expect(layout.edges).toEqual([]);
  });
});

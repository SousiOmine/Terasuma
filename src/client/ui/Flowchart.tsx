import { useId, useMemo } from "preact/hooks";
import type { UiFlowBlock } from "../../shared/ui-markup";
import { t } from "../i18n";
import { FLOW_LINE_HEIGHT, type FlowNodeBox, layoutFlow } from "./flow-layout";

/**
 * フローチャートを SVG で描く。
 *
 * 位置は flow-layout.ts が決める。ここは形と文字を置くだけ。
 * 図が横に広いときは、縮めずに横スクロールにする（文字を読めなくしないため）。
 * 色は styles.css の --app-* トークンだけを使う。
 */
export function Flowchart({ block }: { block: UiFlowBlock }) {
  const layout = useMemo(() => layoutFlow(block), [block]);
  // 同じ画面に複数の図が並ぶので、矢印の id は図ごとに分ける。
  const markerId = useId();

  return (
    <div class="max-w-full overflow-x-auto">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={t("chat.ui.flow")}
        class="block"
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--app-stroke-strong)" />
          </marker>
        </defs>

        {layout.edges.map((edge, index) => (
          <g key={`${edge.from}-${edge.to}-${index}`}>
            <path
              d={edge.path}
              fill="none"
              stroke="var(--app-stroke-strong)"
              stroke-width="1.2"
              stroke-dasharray={edge.dashed ? "4 4" : undefined}
              marker-end={`url(#${markerId})`}
            />
            {edge.label !== null && (
              <text
                x={edge.labelX}
                y={edge.labelY}
                text-anchor="middle"
                font-size="11"
                fill="var(--app-text-secondary)"
                stroke="var(--app-surface-alt)"
                stroke-width="4"
                paint-order="stroke"
              >
                {edge.label}
              </text>
            )}
          </g>
        ))}

        {layout.nodes.map((node) => (
          <g key={node.id}>
            {shapeOf(node)}
            <text text-anchor="middle" font-size="12" fill="var(--app-text)" class="select-none">
              {node.lines.map((line, index) => (
                <tspan key={index} x={node.x + node.width / 2} y={lineY(node, index)}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** ノードの形。形ごとに少しだけ角の丸みを変える。 */
function shapeOf(node: FlowNodeBox) {
  const face = { fill: "var(--app-surface)", stroke: "var(--app-stroke-strong)", "stroke-width": "1.2" } as const;

  switch (node.shape) {
    case "diamond": {
      const points = [
        [node.x + node.width / 2, node.y],
        [node.x + node.width, node.y + node.height / 2],
        [node.x + node.width / 2, node.y + node.height],
        [node.x, node.y + node.height / 2],
      ]
        .map(([x, y]) => `${x},${y}`)
        .join(" ");
      return <polygon points={points} {...face} />;
    }

    case "pill":
      return <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={node.height / 2} {...face} />;

    case "round":
      return <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={16} {...face} />;

    case "box":
      return <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={6} {...face} />;
  }
}

/** 行の baseline。行のまとまりを、ノードの上下の中央に置く。 */
function lineY(node: FlowNodeBox, index: number): number {
  const blockHeight = (node.lines.length - 1) * FLOW_LINE_HEIGHT;
  // 文字の半分（12px のおよそ 4px）だけ下げると、行の中央に揃う。
  return node.y + node.height / 2 - blockHeight / 2 + 4 + index * FLOW_LINE_HEIGHT;
}

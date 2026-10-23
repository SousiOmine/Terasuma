import type { ComponentChildren } from "preact";

/**
 * 状態を表す小さなバッジ（MCP の接続状態など）。
 * 色と形を 1 か所にまとめ、画面ごとに class を書き分けない。
 *
 * 塗りつぶしは使わない。状態の違いは小さな点の色と、バッジに添える文言で表す。
 * 点だけにしてあるのは、一覧に並んだときに色が主張しすぎないようにするため。
 */

export type BadgeTone = "neutral" | "success" | "info" | "warning" | "danger";

const TONES: Record<BadgeTone, { frame: string; dot: string }> = {
  neutral: {
    frame: "bg-soft text-secondary",
    dot: "bg-[var(--app-text-tertiary)]",
  },
  success: {
    frame: "bg-soft text-secondary",
    dot: "bg-[var(--app-success)]",
  },
  info: {
    frame: "bg-soft text-secondary",
    dot: "bg-[var(--app-accent)]",
  },
  warning: {
    frame: "bg-soft text-secondary",
    dot: "bg-[var(--app-warning)]",
  },
  danger: {
    frame: "bg-soft text-secondary",
    dot: "bg-[var(--app-danger)]",
  },
};

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ComponentChildren }) {
  const colors = TONES[tone];

  return (
    <span
      class={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${colors.frame}`}
    >
      <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${colors.dot}`} aria-hidden="true" />
      {children}
    </span>
  );
}

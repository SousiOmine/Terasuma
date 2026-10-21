import type { ComponentChildren } from "preact";

/**
 * 状態を表す小さなバッジ（MCP の接続状態など）。
 * 色と形を 1 か所にまとめ、画面ごとに class を書き分けない。
 *
 * 色相は持たない。状態の違いは「墨で塗る・灰色・輪郭」の 3 段階と、
 * バッジに添える文言で表す。
 */

export type BadgeTone = "neutral" | "success" | "info" | "warning" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-[var(--app-soft)] text-[var(--app-text-secondary)]",
  success: "bg-[var(--app-ink-fill)] text-[var(--app-on-ink)]",
  info: "bg-[var(--app-soft)] text-[var(--app-text)]",
  warning: "border border-[var(--app-ink)] bg-transparent text-[var(--app-text)]",
  danger: "border-2 border-[var(--app-ink)] bg-transparent text-[var(--app-text)]",
};

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ComponentChildren }) {
  return (
    <span class={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

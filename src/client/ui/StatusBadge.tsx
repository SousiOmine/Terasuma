import type { ComponentChildren } from "preact";

/**
 * 状態を表す小さなバッジ（MCP の接続状態など）。
 * 色と形を 1 か所にまとめ、画面ごとに class を書き分けない。
 */

export type BadgeTone = "neutral" | "success" | "info" | "warning" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  danger: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ComponentChildren }) {
  return <span class={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${TONES[tone]}`}>{children}</span>;
}

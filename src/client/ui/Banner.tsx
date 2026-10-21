import type { ComponentChildren } from "preact";

/**
 * チャットの上に出す案内（モデル未設定、podman が無いなど）。
 * 色は使わず、灰色の面と細い点で「案内」だと分かるようにする。
 */

export type BannerTone = "info" | "muted";

const TONES: Record<BannerTone, { frame: string; dot: string; button: string }> = {
  info: {
    frame: "bg-[var(--app-soft)] text-[var(--app-text)]",
    dot: "bg-[var(--app-ink)]",
    button:
      "border-[var(--app-stroke)] bg-[var(--app-surface)] text-[var(--app-text)] hover:bg-[var(--app-soft-strong)]",
  },
  muted: {
    frame: "bg-[var(--app-surface-alt)] text-[var(--app-text-secondary)]",
    dot: "bg-[var(--app-text-tertiary)]",
    button:
      "border-[var(--app-stroke)] bg-[var(--app-surface)] text-[var(--app-text-secondary)] hover:bg-[var(--app-soft)]",
  },
};

export function Banner({
  tone,
  action,
  children,
}: {
  tone: BannerTone;
  /** 右端に置くボタン（設定を開くなど）。 */
  action: { label: string; onClick: () => void };
  children: ComponentChildren;
}) {
  const colors = TONES[tone];

  return (
    <div class="shrink-0 px-3 pt-3 sm:px-4">
      <div
        class={`mx-auto flex w-full max-w-3xl flex-col items-start gap-2 rounded-2xl px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-3 ${colors.frame}`}
      >
        <div class="flex min-w-0 flex-1 items-start gap-2.5">
          <span class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${colors.dot}`} aria-hidden="true" />
          <p class="min-w-0">{children}</p>
        </div>
        <button
          type="button"
          onClick={action.onClick}
          class={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${colors.button}`}
        >
          {action.label}
        </button>
      </div>
    </div>
  );
}

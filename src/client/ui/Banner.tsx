import type { ComponentChildren } from "preact";

/**
 * チャットの上に出す案内（モデル未設定、podman が無いなど）。
 * 同じ形の帯を 2 つ並べていたので、色だけを選べるようにして 1 つにまとめる。
 */

export type BannerTone = "warning" | "muted";

const TONES: Record<BannerTone, { frame: string; text: string; button: string }> = {
  warning: {
    frame: "border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40",
    text: "text-amber-900 dark:text-amber-200",
    button: "border-amber-300 hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/40",
  },
  muted: {
    frame: "border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900",
    text: "text-neutral-700 dark:text-neutral-300",
    button: "border-neutral-300 hover:bg-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800",
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
    <div class={`shrink-0 border-b px-5 py-2 ${colors.frame}`}>
      <div class={`mx-auto flex w-full max-w-3xl items-center gap-3 text-sm ${colors.text}`}>
        <p class="min-w-0 flex-1">{children}</p>
        <button
          type="button"
          onClick={action.onClick}
          class={`shrink-0 rounded-lg border px-2.5 py-1 text-xs transition ${colors.button}`}
        >
          {action.label}
        </button>
      </div>
    </div>
  );
}

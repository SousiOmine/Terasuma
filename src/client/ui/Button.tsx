import type { ComponentChildren } from "preact";

export type ButtonVariant = "primary" | "secondary" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--app-ink-fill)] text-[var(--app-on-ink)] shadow-[var(--app-shadow-2)] hover:bg-[var(--app-ink-hover)]",
  secondary:
    "border border-[var(--app-stroke)] bg-[var(--app-surface)] text-[var(--app-text)] hover:bg-[var(--app-soft)]",
  danger:
    "border-2 border-[var(--app-ink)] bg-transparent text-[var(--app-text)] hover:bg-[var(--app-soft)]",
};

export type ButtonProps = {
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick?: () => void;
  children: ComponentChildren;
};

/** ダイアログと設定画面のボタン。見た目の揺れを無くすため 1 箇所にまとめる。 */
export function Button({ variant = "secondary", disabled = false, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      class={`inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 md:py-2 ${VARIANTS[variant]}`}
    >
      {children}
    </button>
  );
}

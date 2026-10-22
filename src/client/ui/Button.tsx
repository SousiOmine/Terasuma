import type { ComponentChildren } from "preact";

export type ButtonVariant = "primary" | "secondary" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--app-accent-fill)] text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)] hover:bg-[var(--app-accent-hover)]",
  secondary: "bg-[var(--app-soft)] text-[var(--app-text)] hover:bg-[var(--app-soft-strong)]",
  danger: "bg-[var(--app-danger-soft)] text-[var(--app-danger)] hover:bg-[var(--app-soft-strong)]",
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
      class={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full px-4 py-2.5 text-sm font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-40 md:py-2 ${VARIANTS[variant]}`}
    >
      {children}
    </button>
  );
}

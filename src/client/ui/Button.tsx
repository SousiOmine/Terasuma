import type { ComponentChildren } from "preact";

export type ButtonVariant = "primary" | "secondary" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--app-accent-fill)] text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)] hover:bg-[var(--app-accent-hover)]",
  secondary: "bg-soft text-primary hover:bg-[var(--app-soft-strong)]",
  danger: "bg-[var(--app-danger-soft)] text-[var(--app-danger)] hover:bg-[var(--app-soft-strong)]",
};

export type ButtonSize = "md" | "sm";

const SIZES: Record<ButtonSize, string> = {
  md: "px-4 py-2.5 text-sm md:py-2",
  // 一覧の行に置く小さな操作。狭い画面でも指で押せる高さを保つ。
  sm: "px-3 py-1.5 text-xs",
};

export type ButtonProps = {
  variant?: ButtonVariant;
  /** 大きさ。既定は中くらい（ダイアログのフッターなど）。 */
  size?: ButtonSize;
  disabled?: boolean;
  onClick?: () => void;
  children: ComponentChildren;
};

/** ダイアログと設定画面のボタン。見た目の揺れを無くすため 1 箇所にまとめる。 */
export function Button({ variant = "secondary", size = "md", disabled = false, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      class={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${SIZES[size]} ${VARIANTS[variant]}`}
    >
      {children}
    </button>
  );
}

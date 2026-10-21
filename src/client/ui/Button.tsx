import type { ComponentChildren } from "preact";

export type ButtonVariant = "primary" | "secondary" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300",
  secondary: "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800",
  danger: "bg-red-600 text-white hover:bg-red-700",
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
      class={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm transition disabled:opacity-40 md:py-1.5 ${VARIANTS[variant]}`}
    >
      {children}
    </button>
  );
}

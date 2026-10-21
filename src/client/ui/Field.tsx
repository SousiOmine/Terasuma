import type { ComponentChildren } from "preact";

export type FieldProps = {
  label: string;
  /** 何のための項目かを 1 行で。 */
  description?: string;
  /** 入力欄の下に出す補足。 */
  hint?: string;
  children: ComponentChildren;
};

/**
 * ラベル付きの入力欄。
 * 入力そのものは呼び出し側が描く（表示の切り替えなど、欄ごとの操作を添えられるようにするため）。
 * 入力には aria-label を付けること。label 要素で囲まないのは、中にボタンを置けるようにするため。
 */
export function Field({ label, description, hint, children }: FieldProps) {
  return (
    <div class="py-2.5">
      <p class="text-sm font-medium">{label}</p>
      {description !== undefined && <p class="mt-0.5 text-xs text-[var(--app-text-secondary)]">{description}</p>}
      <div class="mt-2">{children}</div>
      {hint !== undefined && <p class="mt-1 text-xs text-[var(--app-text-secondary)]">{hint}</p>}
    </div>
  );
}

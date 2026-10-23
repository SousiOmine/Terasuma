import type { ComponentChildren } from "preact";

/**
 * 設定の節の見出し。
 *
 * 「見出しと説明を左、操作を右。狭い画面では縦に積む」という形は、
 * どの設定画面でも同じになる。見出しを持たない節（説明だけの節）もある。
 */
export function SectionHeader({
  title,
  description,
  action,
}: {
  /** 見出し。説明だけの節では省く。 */
  title?: string;
  description: string;
  action?: ComponentChildren;
}) {
  return (
    <div class="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div class="min-w-0">
        {title !== undefined && <p class="text-sm font-medium">{title}</p>}
        <p class={`text-xs text-secondary ${title === undefined ? "" : "mt-0.5"}`}>{description}</p>
      </div>
      {action}
    </div>
  );
}

import { IconChevronDown } from "@tabler/icons-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { t } from "../i18n";
import { CARD_COMPACT_CLASS } from "./styles";

export type CollapsibleCardProps = {
  /** 見出しに出す名前。 */
  title: string;
  /** 名前の隣に出す印（接続状態など）。 */
  badge?: ComponentChildren;
  /** 見出しの下に出す短い行（説明、アカウント名、確かめた結果）。null は出さない。 */
  lines?: readonly (string | null)[];
  /** 見出しの右に置く操作（切断）。 */
  action?: ComponentChildren;
  /** 最初から開いておくか。既定は閉じている。開閉の初期値にだけ使う。 */
  defaultOpen?: boolean;
  /** 開いたときに出す中身。 */
  children: ComponentChildren;
};

/**
 * 折りたたんでおけるカード。
 *
 * 設定の一覧では、各項目の入力欄を最初から開いておくと縦に長くなり、どれが未設定かを見渡せない。
 * 見出し（名前・状態・短い説明）だけを出し、押したときだけ中身を出す。既定は閉じている。
 * 開閉はカードごとに持ち、一覧を読み直しても（同じ key なら）そのまま保たれる。
 */
export function CollapsibleCard({ title, badge, lines = [], action, defaultOpen = false, children }: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div class={CARD_COMPACT_CLASS}>
      <div class="flex items-start gap-2">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          aria-label={open ? t("settings.connectors.collapse") : t("settings.connectors.expand")}
          onClick={() => setOpen(!open)}
        >
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="truncate text-sm font-medium">{title}</span>
              {badge}
            </span>
            {lines
              .filter((line) => line !== null && line.length > 0)
              .map((line, index) => (
                <span key={index} class="mt-1 block truncate text-xs leading-5 text-secondary">
                  {line}
                </span>
              ))}
          </span>
          <IconChevronDown
            size={14}
            stroke={1.8}
            class={`shrink-0 text-tertiary transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>
        {action !== undefined && <div class="shrink-0">{action}</div>}
      </div>

      {open && <div class="mt-3">{children}</div>}
    </div>
  );
}

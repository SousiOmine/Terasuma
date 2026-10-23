import { IconAlertTriangle } from "@tabler/icons-preact";
import type { ComponentChildren } from "preact";
import type { ErrorState } from "../lib/errors";
import { t } from "../i18n";

export type ErrorNoticeProps = {
  error: ErrorState;
  /** 右端に置く操作（もう一度試す、閉じるなど）。 */
  action?: ComponentChildren;
};

/**
 * 失敗の表示。
 * 面を淡い赤に染め、アイコンと文言で「これは失敗」と分かるようにする。
 * 太い枠線は使わない（失敗のたびに画面の線が強くなり、他の内容を押しのけるため）。
 */
export function ErrorNotice({ error, action }: ErrorNoticeProps) {
  return (
    <div
      role="alert"
      class="flex items-start gap-3 rounded-[16px] bg-[var(--app-danger-soft)] px-4 py-3 text-sm text-primary"
    >
      <IconAlertTriangle size={18} stroke={1.8} class="mt-0.5 shrink-0 text-[var(--app-danger)]" />
      <div class="min-w-0 flex-1">
        <p class="font-medium">{t(`error.${error.code}`)}</p>
        {error.detail !== null && <p class="mt-1 break-words text-xs leading-5 text-secondary">{error.detail}</p>}
      </div>
      {action}
    </div>
  );
}

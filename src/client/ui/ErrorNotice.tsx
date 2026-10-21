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
 * 色は使わず、太い輪郭と警告アイコンで「これは失敗」と分かるようにする。
 */
export function ErrorNotice({ error, action }: ErrorNoticeProps) {
  return (
    <div
      role="alert"
      class="flex items-start gap-3 rounded-2xl border-2 border-[var(--app-ink)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm text-[var(--app-text)]"
    >
      <IconAlertTriangle size={18} stroke={1.8} class="mt-0.5 shrink-0" />
      <div class="min-w-0 flex-1">
        <p class="font-medium">{t(`error.${error.code}`)}</p>
        {error.detail !== null && (
          <p class="mt-1 break-words text-xs leading-5 text-[var(--app-text-secondary)]">{error.detail}</p>
        )}
      </div>
      {action}
    </div>
  );
}

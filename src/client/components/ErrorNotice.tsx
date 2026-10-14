import type { ComponentChildren } from "preact";
import type { ErrorState } from "../errors";
import { t } from "../i18n";

export type ErrorNoticeProps = {
  error: ErrorState;
  /** 右端に置く操作（もう一度試す、閉じるなど）。 */
  action?: ComponentChildren;
};

/** 失敗の表示。文言は error.<code> から引き、技術的な詳細は小さく添える。 */
export function ErrorNotice({ error, action }: ErrorNoticeProps) {
  return (
    <div class="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
      <div class="min-w-0 flex-1">
        <p>{t(`error.${error.code}`)}</p>
        {error.detail !== null && <p class="mt-0.5 break-words text-xs opacity-70">{error.detail}</p>}
      </div>
      {action}
    </div>
  );
}

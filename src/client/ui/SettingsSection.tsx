import type { ComponentChildren } from "preact";
import { t } from "../i18n";
import type { ErrorState } from "../lib/errors";
import { ErrorNotice } from "./ErrorNotice";

/**
 * 設定画面の 1 節。
 *
 * 「中央寄せの幅・見出し・失敗の表示・却下ボタン」は、モデル・MCP・コンピュータの
 * 3 画面で同じ形になる。外枠をここにまとめ、中身だけを画面ごとに書く。
 */
export function SettingsSection({
  title,
  error,
  onDismiss,
  onRetry,
  children,
}: {
  title: string;
  error: ErrorState | null;
  onDismiss: () => void;
  /** 読み込みをやり直せる画面だけ渡す。 */
  onRetry?: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="mx-auto w-full max-w-2xl">
      <h2 class="text-base font-semibold">{title}</h2>

      {error !== null && (
        <div class="mt-4">
          <ErrorNotice
            error={error}
            action={
              <div class="flex shrink-0 flex-col items-end gap-1">
                {onRetry !== undefined && (
                  <button type="button" onClick={onRetry} class="text-xs underline">
                    {t("settings.model.retry")}
                  </button>
                )}
                <button type="button" onClick={onDismiss} class="text-xs opacity-70 transition hover:opacity-100">
                  {t("error.dismiss")}
                </button>
              </div>
            }
          />
        </div>
      )}

      {children}
    </div>
  );
}

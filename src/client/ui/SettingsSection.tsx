import type { ComponentChildren } from "preact";
import { t } from "../i18n";
import type { ErrorState } from "../lib/errors";
import { ErrorNotice } from "./ErrorNotice";

/**
 * 設定画面の外枠。
 *
 * 「中央寄せの幅・見出し」は、どの設定画面でも同じ形になる。
 * 1 画面に複数の節を置く画面（プロバイダ）は、節ごとに SettingsError を置けるよう
 * この外枠だけを使い、失敗の表示は各節に任せる。
 */
export function SettingsPage({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="mx-auto w-full max-w-2xl">
      <h2 class="tera-balance text-[20px] leading-7 font-semibold tracking-[-0.02em]">{title}</h2>
      {children}
    </div>
  );
}

/** 設定画面に出す失敗。読み込み直しと却下の操作を添える。 */
export function SettingsError({
  error,
  onDismiss,
  onRetry,
}: {
  error: ErrorState | null;
  onDismiss: () => void;
  /** 読み込みをやり直せる画面だけ渡す。 */
  onRetry?: () => void;
}) {
  if (error === null) return null;

  return (
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
  );
}

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
    <SettingsPage title={title}>
      <SettingsError error={error} onDismiss={onDismiss} onRetry={onRetry} />
      {children}
    </SettingsPage>
  );
}

import { IconExternalLink } from "@tabler/icons-preact";
import { t } from "../../i18n";

/**
 * 接続確認と認可の案内。ダイアログと設定画面のどちらでも同じ見た目にする。
 * 成功はアクセントの淡い面、認可待ちは灰色の面で表す。
 */

/** 接続を確かめられたことと、そのときに見えたツール。 */
export function CheckedNotice({ tools }: { tools: readonly string[] }) {
  return (
    <div class="rounded-[16px] bg-[var(--app-accent-soft)] px-4 py-3 text-xs text-primary">
      <p>{t("settings.mcp.form.connected")}</p>
      {tools.length === 0 ? (
        <p class="mt-0.5 text-secondary">{t("settings.mcp.noTools")}</p>
      ) : (
        <ul class="mt-2 flex flex-wrap gap-1">
          {tools.map((tool) => (
            <li key={tool} class="rounded-full bg-surface px-2.5 py-1 font-mono text-[11px] text-secondary">
              {tool}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 認可を待っている間の案内。ブラウザのタブを閉じてしまっても、ここから開き直せる。 */
export function AuthorizationNotice({ url }: { url: string }) {
  return (
    <div class="rounded-[16px] bg-surface-alt px-4 py-3 text-xs text-secondary">
      <p>{t("settings.mcp.form.authorize")}</p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        class="mt-1.5 inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
      >
        <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
        {t("settings.mcp.openAuthorization")}
      </a>
    </div>
  );
}

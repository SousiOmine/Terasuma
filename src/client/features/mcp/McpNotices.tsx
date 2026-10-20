import { IconExternalLink } from "@tabler/icons-preact";
import { t } from "../../i18n";

/**
 * 接続確認と認可の案内。ダイアログと設定画面のどちらでも同じ見た目にする。
 */

/** 接続を確かめられたことと、そのときに見えたツール。 */
export function CheckedNotice({ tools }: { tools: readonly string[] }) {
  return (
    <div class="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">
      <p>{t("settings.mcp.form.connected")}</p>
      {tools.length === 0 ? (
        <p class="mt-0.5 opacity-80">{t("settings.mcp.noTools")}</p>
      ) : (
        <ul class="mt-1 flex flex-wrap gap-1">
          {tools.map((tool) => (
            <li key={tool} class="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px] dark:bg-neutral-900/60">
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
    <div class="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200">
      <p>{t("settings.mcp.form.authorize")}</p>
      <a href={url} target="_blank" rel="noreferrer noopener" class="mt-1 inline-flex items-center gap-1 underline">
        <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
        {t("settings.mcp.openAuthorization")}
      </a>
    </div>
  );
}

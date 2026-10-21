import { IconExternalLink } from "@tabler/icons-preact";
import { t } from "../../i18n";

/**
 * 接続確認と認可の案内。ダイアログと設定画面のどちらでも同じ見た目にする。
 * 成功も認可待ちも、灰色の面と墨の文字だけで表す。
 */

/** 接続を確かめられたことと、そのときに見えたツール。 */
export function CheckedNotice({ tools }: { tools: readonly string[] }) {
  return (
    <div class="rounded-2xl bg-[var(--app-soft)] px-4 py-3 text-xs text-[var(--app-text)]">
      <p>{t("settings.mcp.form.connected")}</p>
      {tools.length === 0 ? (
        <p class="mt-0.5 text-[var(--app-text-secondary)]">{t("settings.mcp.noTools")}</p>
      ) : (
        <ul class="mt-2 flex flex-wrap gap-1">
          {tools.map((tool) => (
            <li
              key={tool}
              class="rounded-full bg-[var(--app-surface)] px-2.5 py-1 font-mono text-[11px] text-[var(--app-text-secondary)]"
            >
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
    <div class="rounded-2xl border border-[var(--app-stroke)] bg-[var(--app-surface-alt)] px-4 py-3 text-xs text-[var(--app-text-secondary)]">
      <p>{t("settings.mcp.form.authorize")}</p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        class="mt-1.5 inline-flex items-center gap-1 text-[var(--app-text)] underline-offset-2 hover:underline"
      >
        <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
        {t("settings.mcp.openAuthorization")}
      </a>
    </div>
  );
}

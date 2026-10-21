import { IconSettings } from "@tabler/icons-preact";
import { t } from "../../i18n";
import { openTera } from "../../state/chat";
import { openSettings } from "../../state/route";
import { activeTeraId, teras } from "../../state/session";

/**
 * Tera の一覧。会話は Tera ごとに 1 本なので、並ぶのは会話ではなく Tera。
 * いまは既定の 1 体だけなので、増やす導線は置いていない。
 */
export function Sidebar() {
  const items = teras.value;

  return (
    <aside class="flex w-60 shrink-0 flex-col border-r border-black/5 bg-[#f4f8f5] dark:border-white/5 dark:bg-[#0b100d]">
      <div class="flex h-14 shrink-0 items-center px-4">
        <span class="text-sm font-semibold tracking-wide">{t("app.name")}</span>
      </div>

      <nav class="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p class="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">{t("tera.empty")}</p>
        ) : (
          <ul class="space-y-0.5">
            {items.map((tera) => {
              const active = activeTeraId.value === tera.id;

              return (
                <li key={tera.id}>
                  <button
                    type="button"
                    title={tera.name}
                    aria-current={active ? "true" : undefined}
                    onClick={() => void openTera(tera.id)}
                    class={`w-full truncate rounded-xl px-3 py-2 text-left text-sm transition ${
                      active
                        ? "bg-[#06c755]/12 font-medium text-[#066c36] dark:bg-[#06c755]/15 dark:text-[#7be0a3]"
                        : "text-neutral-700 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
                    }`}
                  >
                    {tera.name}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <SettingsButton />
    </aside>
  );
}

function SettingsButton() {
  return (
    <div class="shrink-0 border-t border-black/5 p-2 dark:border-white/5">
      <button
        type="button"
        onClick={() => openSettings()}
        class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-neutral-600 transition hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
      >
        <IconSettings size={16} stroke={1.6} class="shrink-0" />
        {t("settings.title")}
      </button>
    </div>
  );
}

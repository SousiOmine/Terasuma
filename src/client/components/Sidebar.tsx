import { IconSettings } from "@tabler/icons-preact";
import { t } from "../i18n";
import { activeTeraId, openSettings, openTera, teras } from "../state";

/**
 * Tera の一覧。会話は Tera ごとに 1 本なので、並ぶのは会話ではなく Tera。
 * いまは既定の 1 体だけなので、増やす導線は置いていない。
 */
export function Sidebar() {
  const items = teras.value;

  return (
    <aside class="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-100/70 dark:border-neutral-800 dark:bg-neutral-900/40">
      <div class="flex h-12 shrink-0 items-center px-4">
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
                    class={`w-full truncate rounded-lg px-3 py-2 text-left text-sm transition ${
                      active
                        ? "bg-white shadow-sm dark:bg-neutral-800"
                        : "hover:bg-neutral-200/60 dark:hover:bg-neutral-800/50"
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
    <div class="shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-800">
      <button
        type="button"
        onClick={() => openSettings()}
        class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-600 transition hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800/60"
      >
        <IconSettings size={16} stroke={1.6} class="shrink-0" />
        {t("settings.title")}
      </button>
    </div>
  );
}

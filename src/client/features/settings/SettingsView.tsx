import { IconArrowLeft } from "@tabler/icons-preact";
import type { Locale, MessageKey } from "../../i18n";
import { LOCALES, locale, setLocale, t } from "../../i18n";
import { closeSettings, setSettingsCategory, settingsCategory, type SettingsCategory } from "../../state/route";
import { ContainerSettingsView } from "../container/ContainerSettingsView";
import { McpSettingsView } from "../mcp/McpSettingsView";
import { ModelSettingsView } from "../model/ModelSettingsView";

/** 左ペインに並べるカテゴリ。増やすときはここに足す。 */
const CATEGORIES: readonly { id: SettingsCategory; labelKey: MessageKey }[] = [
  { id: "general", labelKey: "settings.general" },
  { id: "model", labelKey: "settings.model" },
  { id: "container", labelKey: "settings.container" },
  { id: "advanced", labelKey: "settings.advanced" },
];

/** 言語名はその言語自身で書く（どの言語で表示していても読めるように）。 */
const LOCALE_LABELS: Record<Locale, string> = { ja: "日本語", en: "English" };

export function SettingsView() {
  // カテゴリは signal で持つ。チャット画面の案内から「モデル」を直接開けるようにするため。
  const category = settingsCategory.value;

  return (
    <div class="flex h-full flex-col">
      <header class="flex h-12 shrink-0 items-center border-b border-neutral-200 px-3 dark:border-neutral-800">
        <button
          type="button"
          onClick={closeSettings}
          class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-neutral-600 transition hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <IconArrowLeft size={16} stroke={1.6} class="shrink-0" />
          {t("settings.back")}
        </button>
      </header>

      <div class="flex min-h-0 flex-1">
        <nav class="w-56 shrink-0 border-r border-neutral-200 p-2 dark:border-neutral-800">
          <h1 class="px-3 pb-2 pt-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            {t("settings.title")}
          </h1>
          <ul class="space-y-0.5">
            {CATEGORIES.map((item) => {
              const active = category === item.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => setSettingsCategory(item.id)}
                    class={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                      active
                        ? "bg-white shadow-sm dark:bg-neutral-800"
                        : "hover:bg-neutral-200/60 dark:hover:bg-neutral-800/50"
                    }`}
                  >
                    {t(item.labelKey)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section class="min-w-0 flex-1 overflow-y-auto px-6 py-8">
          {category === "general" && <GeneralSettings />}
          {category === "model" && <ModelSettingsView />}
          {category === "container" && <ContainerSettingsView />}
          {category === "advanced" && <McpSettingsView />}
        </section>
      </div>
    </div>
  );
}

function GeneralSettings() {
  return (
    <div class="mx-auto w-full max-w-2xl">
      <h2 class="text-base font-semibold">{t("settings.general")}</h2>

      <div class="mt-6 flex items-center justify-between gap-6 border-b border-neutral-200 pb-5 dark:border-neutral-800">
        <div class="min-w-0">
          <p class="text-sm font-medium">{t("settings.language.label")}</p>
          <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{t("settings.language.description")}</p>
        </div>

        <div class="flex shrink-0 gap-1 rounded-lg bg-neutral-200/60 p-0.5 dark:bg-neutral-800">
          {LOCALES.map((code) => {
            const active = locale.value === code;
            return (
              <button
                key={code}
                type="button"
                aria-pressed={active}
                onClick={() => setLocale(code)}
                class={`rounded-md px-3 py-1 text-xs transition ${
                  active
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-700"
                }`}
              >
                {LOCALE_LABELS[code]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

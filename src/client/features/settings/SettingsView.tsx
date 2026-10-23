import { IconArrowLeft } from "@tabler/icons-preact";
import type { Locale, MessageKey } from "../../i18n";
import { LOCALES, locale, setLocale, t } from "../../i18n";
import { closeSettings, setSettingsCategory, settingsCategory, type SettingsCategory } from "../../state/route";
import { Segmented } from "../../ui/Segmented";
import { ContainerSettingsView } from "../container/ContainerSettingsView";
import { ConnectionsSettingsView } from "../connections/ConnectionsSettingsView";
import { McpSettingsView } from "../mcp/McpSettingsView";
import { ModelSettingsView } from "../model/ModelSettingsView";
import { ProviderSettingsView } from "../providers/ProviderSettingsView";

/** 左ペインに並べるカテゴリ。増やすときはここに足す。 */
const CATEGORIES: readonly { id: SettingsCategory; labelKey: MessageKey }[] = [
  { id: "general", labelKey: "settings.general" },
  { id: "model", labelKey: "settings.model" },
  { id: "providers", labelKey: "settings.providers" },
  { id: "connections", labelKey: "settings.connections" },
  { id: "container", labelKey: "settings.container" },
  { id: "advanced", labelKey: "settings.advanced" },
];

/** 言語名はその言語自身で書く（どの言語で表示していても読めるように）。 */
const LOCALE_LABELS: Record<Locale, string> = { ja: "日本語", en: "English" };

export function SettingsView() {
  // カテゴリは signal で持つ。チャット画面の案内から「モデル」を直接開けるようにするため。
  const category = settingsCategory.value;

  return (
    <div class="tera-fade-in flex h-full flex-col bg-[var(--app-canvas)]">
      <header class="flex h-16 shrink-0 items-center gap-3 px-3 sm:px-5">
        <button
          type="button"
          onClick={closeSettings}
          class="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-secondary transition hover:bg-soft hover:text-primary"
        >
          <IconArrowLeft size={17} stroke={1.7} class="shrink-0" />
          {t("settings.back")}
        </button>
        {/* md 未満ではカテゴリの見出しを見せないので、何の画面かをここに出す。 */}
        <h1 class="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] md:hidden">
          {t("settings.title")}
        </h1>
      </header>

      <div class="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav class="shrink-0 px-3 pb-2 md:w-[248px] md:py-1 md:pb-0">
          <h1 class="hidden px-3 pb-2 text-xs font-medium text-secondary md:block">{t("settings.title")}</h1>
          <ul class="flex flex-wrap gap-1 md:flex-col md:gap-1">
            {CATEGORIES.map((item) => {
              const active = category === item.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => setSettingsCategory(item.id)}
                    class={`rounded-2xl px-3.5 py-2.5 text-left text-sm whitespace-nowrap transition md:w-full ${
                      active
                        ? "bg-[var(--app-accent-soft)] font-medium text-[var(--app-accent-ink)]"
                        : "text-secondary hover:bg-soft hover:text-primary"
                    }`}
                  >
                    {t(item.labelKey)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section class="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface px-4 py-6 md:m-3 md:ml-0 md:rounded-[30px] md:border md:border-stroke md:px-10 md:py-10 md:shadow-[var(--app-shadow-panel)]">
          {/* カテゴリを切り替えたら、本文だけを短く入れ替える（外枠は動かさない）。
              ここに transform を残すと、中で開くダイアログの fixed の基準が変わってしまうため、
              移動は付けず、濃さの変化だけにする。 */}
          <div key={category} class="tera-fade-in">
            {category === "general" && <GeneralSettings />}
            {category === "model" && <ModelSettingsView />}
            {category === "providers" && <ProviderSettingsView />}
            {category === "connections" && <ConnectionsSettingsView />}
            {category === "container" && <ContainerSettingsView />}
            {category === "advanced" && <McpSettingsView />}
          </div>
        </section>
      </div>
    </div>
  );
}

function GeneralSettings() {
  return (
    <div class="mx-auto w-full max-w-2xl">
      <h2 class="text-[20px] leading-7 font-semibold tracking-[-0.02em]">{t("settings.general")}</h2>

      <div class="mt-6 flex flex-col items-start gap-4 border-b border-stroke pb-6 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div class="min-w-0">
          <p class="text-[13px] font-medium">{t("settings.language.label")}</p>
          <p class="mt-1 text-xs leading-5 text-secondary">{t("settings.language.description")}</p>
        </div>

        <div class="w-48 shrink-0">
          <Segmented
            options={LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code] }))}
            value={locale.value}
            onChange={setLocale}
          />
        </div>
      </div>
    </div>
  );
}

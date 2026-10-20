import { useEffect, useState } from "preact/hooks";
import { OPENAI_COMPATIBLE_TEMPLATE, type EndpointPreset } from "../../../shared/providers";
import { t } from "../../i18n";
import { type ErrorState, toErrorState } from "../../lib/errors";
import { catalogProviders, loadCatalog } from "../../state/model";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { SearchInput } from "../../ui/SearchInput";
import { chooserEntries } from "./providerForm";

/**
 * プロバイダを選ぶ段。
 * カタログのプロバイダと、接続先を自分で決めるエンドポイントを同じ並びに置く。
 */

/** 雛形の表示名。Ollama のような固有名詞はそのまま出す。 */
export function presetName(preset: EndpointPreset): string {
  return preset.id === OPENAI_COMPATIBLE_TEMPLATE.id ? t("provider.custom.name") : preset.name;
}

/** プロバイダを選ぶ段。カタログの一覧を絞り込みながら選ぶ。 */
export function ProviderChooser({
  onSelectCatalog,
  onSelectPreset,
  error,
  onError,
}: {
  onSelectCatalog: (id: string, name: string) => void;
  onSelectPreset: (preset: EndpointPreset) => void;
  error: ErrorState | null;
  onError: (error: ErrorState | null) => void;
}) {
  const [query, setQuery] = useState("");
  const list = catalogProviders.value;

  useEffect(() => {
    if (catalogProviders.value !== null) return;

    void loadCatalog().catch((failure: unknown) => onError(toErrorState(failure)));
  }, []);

  const keyword = query.trim().toLowerCase();
  const visible = chooserEntries(list, presetName).filter(
    (entry) => keyword.length === 0 || entry.name.toLowerCase().includes(keyword) || entry.id.includes(keyword),
  );

  return (
    <div class="space-y-3">
      <SearchInput value={query} onInput={setQuery} placeholder={t("settings.wizard.search")} />

      {error !== null && <ErrorNotice error={error} />}

      <div class="max-h-80 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        {list === null ? (
          <p class="px-3 py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">{t("chat.loading")}</p>
        ) : visible.length === 0 ? (
          <p class="px-3 py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
            {t("settings.wizard.noMatch")}
          </p>
        ) : (
          <ul class="p-1">
            {visible.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`}>
                <button
                  type="button"
                  onClick={() =>
                    entry.kind === "catalog" ? onSelectCatalog(entry.id, entry.name) : onSelectPreset(entry.preset)
                  }
                  class="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <span class="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.models !== null && (
                    <span class="shrink-0 text-[11px] text-neutral-400 dark:text-neutral-500">{entry.models}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

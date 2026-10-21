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

      <div class="max-h-80 overflow-y-auto rounded-2xl border border-[var(--app-stroke)] bg-[var(--app-surface)] p-1.5">
        {list === null ? (
          <p class="px-3 py-4 text-center text-xs text-[var(--app-text-secondary)]">{t("common.loading")}</p>
        ) : visible.length === 0 ? (
          <p class="px-3 py-4 text-center text-xs text-[var(--app-text-secondary)]">{t("settings.wizard.noMatch")}</p>
        ) : (
          <ul class="space-y-0.5">
            {visible.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`}>
                <button
                  type="button"
                  onClick={() =>
                    entry.kind === "catalog" ? onSelectCatalog(entry.id, entry.name) : onSelectPreset(entry.preset)
                  }
                  class="flex w-full items-baseline gap-2 rounded-xl px-3 py-2 text-left text-sm text-[var(--app-text)] transition hover:bg-[var(--app-soft)]"
                >
                  <span class="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.models !== null && (
                    <span class="shrink-0 text-[11px] text-[var(--app-text-tertiary)]">{entry.models}</span>
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

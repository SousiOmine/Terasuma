import { IconCheck } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { t } from "../../i18n";
import { SearchInput } from "../../ui/SearchInput";

export type ModelListProps = {
  models: readonly string[];
  /** 選択中のモデル。プロバイダ名を含まない、プロバイダ側の ID。 */
  value: string | null;
  onChange: (model: string) => void;
  /** いま既定になっているモデル。一覧の中で印を付ける。 */
  currentModel?: string | null;
};

/** モデルの一覧。絞り込みと選択だけを持つ。 */
export function ModelList({ models, value, onChange, currentModel = null }: ModelListProps) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const visible = keyword.length === 0 ? models : models.filter((model) => model.toLowerCase().includes(keyword));

  return (
    <div>
      <SearchInput value={query} onInput={setQuery} placeholder={t("settings.model.searchModel")} />

      <div class="mt-2 max-h-64 overflow-y-auto rounded-[16px] bg-[var(--app-surface-alt)] p-1.5">
        {visible.length === 0 ? (
          <p class="px-3 py-4 text-center text-xs text-[var(--app-text-secondary)]">{t("settings.model.noMatch")}</p>
        ) : (
          <ul class="space-y-0.5">
            {visible.map((model) => {
              const selected = model === value;
              return (
                <li key={model}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChange(model)}
                    class={`flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-sm transition ${
                      selected
                        ? "bg-[var(--app-accent-soft)] font-medium text-[var(--app-text)]"
                        : "text-[var(--app-text)] hover:bg-[var(--app-soft-strong)]"
                    }`}
                  >
                    <span class="min-w-0 flex-1 truncate">{model}</span>
                    {model === currentModel && (
                      <span class="flex shrink-0 items-center gap-1 text-[11px] text-[var(--app-text-secondary)]">
                        <IconCheck size={14} stroke={1.6} />
                        {t("settings.model.current")}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

import { IconCheck, IconSearch } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { t } from "../i18n";

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
      <div class="relative">
        <IconSearch
          size={16}
          stroke={1.6}
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
        />
        <input
          type="search"
          value={query}
          placeholder={t("settings.model.searchModel")}
          aria-label={t("settings.model.searchModel")}
          class="w-full rounded-lg border border-neutral-300 bg-white py-1.5 pl-8 pr-3 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-600"
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      <div class="mt-2 max-h-64 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        {visible.length === 0 ? (
          <p class="px-3 py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
            {t("settings.model.noMatch")}
          </p>
        ) : (
          <ul class="p-1">
            {visible.map((model) => {
              const selected = model === value;
              return (
                <li key={model}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChange(model)}
                    class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${
                      selected
                        ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                        : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <span class="min-w-0 flex-1 truncate">{model}</span>
                    {model === currentModel && (
                      <span class="flex shrink-0 items-center gap-1 text-[11px] opacity-70">
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

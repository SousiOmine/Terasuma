import { useState } from "preact/hooks";
import { useResourceOnce } from "../../hooks/useResourceOnce";
import { OPENAI_COMPATIBLE_TEMPLATE, type EndpointPreset } from "../../../shared/providers";
import { t } from "../../i18n";
import type { ErrorState } from "../../lib/errors";
import { catalogLoadError, catalogProviders, catalogResource, isLoadingCatalog } from "../../state/model";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { LoadOrError } from "../../ui/LoadOrError";
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
}: {
  onSelectCatalog: (id: string, name: string) => void;
  onSelectPreset: (preset: EndpointPreset) => void;
  /** 呼び出し側が持つ失敗（接続確認など）。カタログの失敗は Resource が持つ。 */
  error: ErrorState | null;
}) {
  const [query, setQuery] = useState("");
  const list = catalogProviders.value;

  // カタログは、まだ読めていなければ読む（失敗は Resource が持ち、下で表示する）。
  useResourceOnce(catalogResource);

  const keyword = query.trim().toLowerCase();
  const visible = chooserEntries(list, presetName).filter(
    (entry) => keyword.length === 0 || entry.name.toLowerCase().includes(keyword) || entry.id.includes(keyword),
  );

  return (
    <div class="space-y-3">
      <SearchInput value={query} onInput={setQuery} placeholder={t("settings.wizard.search")} />

      {error !== null && <ErrorNotice error={error} />}

      <div class="max-h-80 overflow-y-auto rounded-[16px] bg-surface-alt p-1.5">
        {list === null ? (
          <div class="px-3 py-4">
            <LoadOrError loading={isLoadingCatalog.value} error={catalogLoadError.value} />
          </div>
        ) : visible.length === 0 ? (
          <p class="px-3 py-4 text-center text-xs text-secondary">{t("settings.wizard.noMatch")}</p>
        ) : (
          <ul class="space-y-0.5">
            {visible.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`}>
                <button
                  type="button"
                  onClick={() =>
                    entry.kind === "catalog" ? onSelectCatalog(entry.id, entry.name) : onSelectPreset(entry.preset)
                  }
                  class="flex w-full items-baseline gap-2 rounded-[12px] px-3 py-2 text-left text-sm text-primary transition hover:bg-[var(--app-soft-strong)]"
                >
                  <span class="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.models !== null && <span class="shrink-0 text-[11px] text-tertiary">{entry.models}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import { IconPlus } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import type { WebSearchProviderView } from "../../../shared/api/settings";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import { t } from "../../i18n";
import {
  clearWebSearchError,
  isLoadingWebSearch,
  loadWebSearchSettings,
  refreshWebSearchSettings,
  removeWebSearchProvider,
  setDefaultWebSearchProvider,
  showWebSearchError,
  webSearchError,
  webSearchSettings,
} from "../../state/websearch";
import { Button } from "../../ui/Button";
import { ResourceList } from "../../ui/ResourceList";
import { SectionHeader } from "../../ui/SectionHeader";
import { DeleteAction, EditAction } from "../../ui/CardActions";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SettingsError } from "../../ui/SettingsSection";
import { CARD_CLASS } from "../../ui/styles";
import { WebSearchProviderDialog, type WebSearchDialogMode } from "./WebSearchProviderDialog";

/**
 * 設定「プロバイダ」の Web 検索プロバイダ。
 *
 * エージェントが使う検索プロバイダを、1 つだけ既定として選ぶ。
 * 追加はダイアログの中で検索できることを確かめてから行う。
 * ページ取得は、プロバイダの API があるときだけそれを使い、無ければ直接読み込む。
 */
export function WebSearchProviderSection() {
  const view = webSearchSettings.value;
  const error = webSearchError.value;

  const [dialog, setDialog] = useState<WebSearchDialogMode | null>(null);
  /** 既定を切り替えているプロバイダ。二度押しを避けるために覚えておく。 */
  const [makingDefault, setMakingDefault] = useState<string | null>(null);
  const deleting = useDeleteTarget<WebSearchProviderView>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (webSearchSettings.value !== null || isLoadingWebSearch.value) return;
    void loadWebSearchSettings().catch(showWebSearchError);
  }, []);

  const reload = () => void refreshWebSearchSettings().catch(showWebSearchError);

  const makeDefault = async (providerId: string) => {
    setMakingDefault(providerId);
    try {
      await setDefaultWebSearchProvider(providerId);
    } catch (failure) {
      showWebSearchError(failure);
    } finally {
      setMakingDefault(null);
    }
  };

  return (
    <>
      <SettingsError error={error} onDismiss={clearWebSearchError} onRetry={view === null ? reload : undefined} />

      <SectionHeader
        title={t("settings.webSearch")}
        description={t("settings.webSearch.description")}
        action={
          <Button
            variant="primary"
            disabled={view === null || view.available.length === 0}
            onClick={() => {
              if (view !== null) setDialog({ kind: "add", available: view.available });
            }}
          >
            <IconPlus size={16} stroke={1.6} class="shrink-0" />
            {t("settings.webSearch.add")}
          </Button>
        }
      />

      <ResourceList data={view === null ? null : view.providers} empty={t("settings.webSearch.empty")}>
        {(provider) => (
          <WebSearchProviderCard
            key={provider.id}
            provider={provider}
            makingDefault={makingDefault === provider.id}
            onMakeDefault={() => void makeDefault(provider.id)}
            onEdit={() => setDialog({ kind: "edit", provider })}
            onDelete={() => deleting.open(provider)}
          />
        )}
      </ResourceList>

      {dialog !== null && <WebSearchProviderDialog mode={dialog} onClose={() => setDialog(null)} />}

      {deleting.target !== null && (
        <ConfirmDialog
          title={t("settings.webSearch.deleteTitle")}
          subject={deleting.target.name}
          message={t(
            deleting.target.isDefault ? "settings.webSearch.deleteMessageDefault" : "settings.webSearch.deleteMessage",
          )}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => deleting.confirm(removeWebSearchProvider, showWebSearchError)}
          onCancel={deleting.close}
        />
      )}
    </>
  );
}

type WebSearchProviderCardProps = {
  provider: WebSearchProviderView;
  makingDefault: boolean;
  onMakeDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function WebSearchProviderCard({
  provider,
  makingDefault,
  onMakeDefault,
  onEdit,
  onDelete,
}: WebSearchProviderCardProps) {
  const detail = [
    t(provider.supportsFetch ? "settings.webSearch.fetchApi" : "settings.webSearch.fetchDirect"),
    t(provider.hasApiKey ? "settings.webSearch.apiKeySet" : "settings.webSearch.apiKeyUnset"),
  ].join("・");

  return (
    <div class={`flex flex-col gap-3 sm:flex-row sm:items-start ${CARD_CLASS}`}>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <p class="truncate text-sm font-medium">{provider.name}</p>
          {provider.isDefault && (
            <span class="shrink-0 rounded-full bg-surface px-2.5 py-1 text-[11px] font-medium text-secondary">
              {t("common.default")}
            </span>
          )}
        </div>
        <p class="mt-0.5 text-xs text-secondary">{detail}</p>
      </div>

      <div class="flex shrink-0 flex-wrap items-center gap-1">
        {!provider.isDefault && (
          <button
            type="button"
            disabled={makingDefault}
            onClick={onMakeDefault}
            class="rounded-full bg-[var(--app-accent-fill)] px-3 py-1.5 text-xs font-medium text-[var(--app-on-accent)] transition hover:bg-[var(--app-accent-hover)] disabled:opacity-50"
          >
            {t("settings.webSearch.makeDefault")}
          </button>
        )}
        <EditAction onClick={onEdit} />
        <DeleteAction onClick={onDelete} />
      </div>
    </div>
  );
}

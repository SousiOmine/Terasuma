import { IconPlus } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { modelProvider } from "../../../shared/model";
import type { ProviderView } from "../../../shared/types";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import { t } from "../../i18n";
import {
  catalogProviders,
  clearSettingsError,
  isLoadingSettings,
  loadCatalog,
  loadModelSettings,
  modelSettings,
  providerName,
  removeProvider,
  settingsError,
  showSettingsError,
} from "../../state/model";
import { Button } from "../../ui/Button";
import { DeleteAction, EditAction } from "../../ui/CardActions";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SettingsError } from "../../ui/SettingsSection";
import { CARD_CLASS } from "../../ui/styles";
import { ProviderWizard, type WizardMode } from "../model/ProviderWizard";

/**
 * 設定「プロバイダ」の LLM（モデル）プロバイダ。
 *
 * 一覧には保存されたプロバイダをそのまま並べ、既定のモデルを使うプロバイダには
 * 「既定」を付ける。削除は既定のモデルを消さない（モデルは選び直しになるため、
 * 何が起きるかを確認の文で伝える）。
 */
export function LlmProviderSection() {
  const settings = modelSettings.value;
  const error = settingsError.value;
  const loading = isLoadingSettings.value;

  const [wizard, setWizard] = useState<WizardMode | null>(null);
  const deleting = useDeleteTarget<ProviderView>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (modelSettings.value !== null || isLoadingSettings.value) return;
    void loadModelSettings().catch(showSettingsError);
  }, []);

  useEffect(() => {
    // プロバイダの表示名はカタログの名前を使うので、この節で読む。
    if (catalogProviders.value !== null) return;
    void loadCatalog().catch(showSettingsError);
  }, []);

  const reload = () => void loadModelSettings().catch(showSettingsError);

  const defaultProviderId =
    settings?.model === null || settings?.model === undefined ? null : modelProvider(settings.model);
  const holdsDefault = deleting.target !== null && deleting.target.id === defaultProviderId;

  return (
    <>
      <SettingsError error={error} onDismiss={clearSettingsError} onRetry={settings === null ? reload : undefined} />

      <div class="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div class="min-w-0">
          <p class="text-sm font-medium">{t("settings.providers.llm.label")}</p>
          <p class="mt-0.5 text-xs text-[var(--app-text-secondary)]">{t("settings.providers.llm.description")}</p>
        </div>
        <Button variant="primary" onClick={() => setWizard({ kind: "add" })}>
          <IconPlus size={16} stroke={1.6} class="shrink-0" />
          {t("settings.providers.llm.add")}
        </Button>
      </div>

      <div class="mt-3 space-y-2">
        {settings === null && loading ? (
          <p class="text-xs text-[var(--app-text-secondary)]">{t("common.loading")}</p>
        ) : settings === null || settings.providers.length === 0 ? (
          <p class="text-xs text-[var(--app-text-secondary)]">{t("settings.providers.llm.empty")}</p>
        ) : (
          settings.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isDefault={settings.model !== null && modelProvider(settings.model) === provider.id}
              onEdit={() => setWizard({ kind: "edit", provider })}
              onDelete={() => deleting.open(provider)}
            />
          ))
        )}
      </div>

      {wizard !== null && <ProviderWizard mode={wizard} onClose={() => setWizard(null)} />}

      {deleting.target !== null && (
        <ConfirmDialog
          title={t("settings.providers.llm.deleteTitle")}
          subject={deleting.target.name}
          message={t(
            holdsDefault ? "settings.providers.llm.deleteMessageDefault" : "settings.providers.llm.deleteMessage",
          )}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => deleting.confirm(removeProvider, showSettingsError)}
          onCancel={deleting.close}
        />
      )}
    </>
  );
}

type ProviderCardProps = {
  provider: ProviderView;
  isDefault: boolean;
  onEdit: () => void;
  onDelete: () => void;
};

function ProviderCard({ provider, isDefault, onEdit, onDelete }: ProviderCardProps) {
  const keyState = provider.hasApiKey ? t("settings.providers.llm.apiKeySet") : t("settings.providers.llm.apiKeyUnset");

  return (
    <div class={`flex flex-col gap-3 sm:flex-row sm:items-start ${CARD_CLASS}`}>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <p class="truncate text-sm font-medium">{providerName(provider)}</p>
          {isDefault && (
            <span class="shrink-0 rounded-full bg-[var(--app-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--app-text-secondary)]">
              {t("common.default")}
            </span>
          )}
        </div>
        <p class="mt-0.5 truncate text-xs text-[var(--app-text-secondary)]">
          {provider.baseUrl === null ? (
            keyState
          ) : (
            <>
              <span class="font-mono">{provider.baseUrl}</span>・{keyState}
            </>
          )}
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <EditAction onClick={onEdit} />
        <DeleteAction onClick={onDelete} />
      </div>
    </div>
  );
}

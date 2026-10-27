import { IconPlus } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { useResourceOnce } from "../../hooks/useResourceOnce";
import { modelProvider } from "../../../shared/model";
import type { ProviderView } from "../../../shared/api/settings";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import { t } from "../../i18n";
import {
  catalogResource,
  clearSettingsError,
  isLoadingSettings,
  modelLoadError,
  modelResource,
  modelSettings,
  providerName,
  refreshModelSettings,
  removeProvider,
  settingsError,
  showSettingsError,
} from "../../state/model";
import { Button } from "../../ui/Button";
import { ResourceList } from "../../ui/ResourceList";
import { SectionHeader } from "../../ui/SectionHeader";
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

  // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
  useResourceOnce(modelResource);
  // プロバイダの表示名はカタログの名前を使うので、この節で読む。
  useResourceOnce(catalogResource);

  const reload = () => void refreshModelSettings().catch(showSettingsError);

  const defaultProviderId =
    settings?.model === null || settings?.model === undefined ? null : modelProvider(settings.model);
  const holdsDefault = deleting.target !== null && deleting.target.id === defaultProviderId;

  return (
    <>
      <SettingsError error={error} onDismiss={clearSettingsError} onRetry={settings === null ? reload : undefined} />

      <SectionHeader
        title={t("settings.providers.llm.label")}
        description={t("settings.providers.llm.description")}
        action={
          <Button variant="primary" onClick={() => setWizard({ kind: "add" })}>
            <IconPlus size={16} stroke={1.6} class="shrink-0" />
            {t("settings.providers.llm.add")}
          </Button>
        }
      />

      <ResourceList
        data={settings === null ? null : settings.providers}
        loading={loading}
        error={modelLoadError.value}
        empty={t("settings.providers.llm.empty")}
      >
        {(provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            isDefault={settings !== null && settings.model !== null && modelProvider(settings.model) === provider.id}
            onEdit={() => setWizard({ kind: "edit", provider })}
            onDelete={() => deleting.open(provider)}
          />
        )}
      </ResourceList>

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
            <span class="shrink-0 rounded-full bg-surface px-2.5 py-1 text-[11px] font-medium text-secondary">
              {t("common.default")}
            </span>
          )}
        </div>
        <p class="mt-0.5 truncate text-xs text-secondary">
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

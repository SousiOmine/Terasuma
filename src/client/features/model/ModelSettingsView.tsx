import { IconAlertTriangle, IconPlus } from "@tabler/icons-preact";
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
  loadReasoning,
  modelProblem,
  modelReasoning,
  modelSettings,
  providerName,
  removeProvider,
  saveReasoning,
  settingsError,
  showSettingsError,
} from "../../state/model";
import { Button } from "../../ui/Button";
import { DeleteAction, EditAction } from "../../ui/CardActions";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ModelPickerDialog } from "./ModelPickerDialog";
import { ProviderWizard, type WizardMode } from "./ProviderWizard";
import { SettingsSection } from "../../ui/SettingsSection";
import { CARD_CLASS, INPUT_CLASS } from "../../ui/styles";

/**
 * 設定の「モデル」。
 *
 * 上に既定のモデル、下にプロバイダを置く。既定のモデルは必ずどれかのプロバイダのものなので、
 * 先にプロバイダを足してもらう順番が自然に伝わる並びにしてある。
 */
export function ModelSettingsView() {
  const settings = modelSettings.value;
  const problem = modelProblem.value;
  const error = settingsError.value;
  const loading = isLoadingSettings.value;
  const reasoning = modelReasoning.value;
  const currentModel = settings?.model ?? null;

  const [wizard, setWizard] = useState<WizardMode | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const deleting = useDeleteTarget<ProviderView>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (modelSettings.value !== null || isLoadingSettings.value) return;
    void loadModelSettings().catch(showSettingsError);
  }, []);

  useEffect(() => {
    // プロバイダの表示名はカタログの名前を使うので、この画面で読む。
    if (catalogProviders.value !== null) return;
    void loadCatalog().catch(showSettingsError);
  }, []);

  useEffect(() => {
    // 思考強度はモデルごとの設定。選ばれているモデルの分だけを読む。
    if (currentModel === null) {
      modelReasoning.value = null;
      return;
    }
    void loadReasoning().catch(showSettingsError);
  }, [currentModel]);

  const reload = () => void loadModelSettings().catch(showSettingsError);

  const changeReasoning = async (effort: string | null) => {
    try {
      await saveReasoning(effort);
    } catch (failure) {
      showSettingsError(failure);
    }
  };

  const defaultProviderId =
    settings?.model === null || settings?.model === undefined ? null : modelProvider(settings.model);
  const holdsDefault = deleting.target !== null && deleting.target.id === defaultProviderId;

  return (
    <SettingsSection
      title={t("settings.model")}
      error={error}
      onDismiss={clearSettingsError}
      onRetry={settings === null ? reload : undefined}
    >
      <section class="mt-6 border-b border-[var(--app-stroke)] pb-5">
        <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div class="min-w-0">
            <p class="text-sm font-medium">{t("settings.model.default.label")}</p>
            <p class="mt-0.5 text-xs text-[var(--app-text-secondary)]">{t("settings.model.default.description")}</p>
          </div>
          <Button disabled={settings === null || settings.providers.length === 0} onClick={() => setPickerOpen(true)}>
            {t("settings.model.default.change")}
          </Button>
        </div>

        <p class="mt-3 truncate font-mono text-[13px]">{settings?.model ?? t("settings.model.default.unset")}</p>
        {problem === "unset" && (
          <p class="mt-1 text-xs text-[var(--app-text-secondary)]">{t("settings.model.default.unsetHint")}</p>
        )}
        {problem === "provider-missing" && (
          <p class="mt-1 flex items-center gap-1.5 text-xs font-medium text-[var(--app-text)]">
            <IconAlertTriangle size={14} stroke={1.8} class="shrink-0" />
            {t("settings.model.default.missingProvider")}
          </p>
        )}

        {reasoning !== null && reasoning.values.length > 0 && (
          <div class="mt-4 flex flex-col items-start gap-3 border-t border-[var(--app-stroke)] pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div class="min-w-0">
              <p class="text-sm font-medium">{t("settings.model.reasoning.label")}</p>
              <p class="mt-0.5 text-xs text-[var(--app-text-secondary)]">{t("settings.model.reasoning.description")}</p>
            </div>
            <select
              value={reasoning.effort ?? ""}
              aria-label={t("settings.model.reasoning.label")}
              class={`${INPUT_CLASS} sm:w-auto`}
              onChange={(event) =>
                void changeReasoning(event.currentTarget.value === "" ? null : event.currentTarget.value)
              }
            >
              <option value="">{t("common.default")}</option>
              {reasoning.values.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section class="mt-6">
        <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div class="min-w-0">
            <p class="text-sm font-medium">{t("settings.model.providers.label")}</p>
            <p class="mt-0.5 text-xs text-[var(--app-text-secondary)]">{t("settings.model.providers.description")}</p>
          </div>
          <Button variant="primary" onClick={() => setWizard({ kind: "add" })}>
            <IconPlus size={16} stroke={1.6} class="shrink-0" />
            {t("settings.model.providers.add")}
          </Button>
        </div>

        <div class="mt-3 space-y-2">
          {settings === null && loading ? (
            <p class="text-xs text-[var(--app-text-secondary)]">{t("common.loading")}</p>
          ) : settings === null || settings.providers.length === 0 ? (
            <p class="text-xs text-[var(--app-text-secondary)]">{t("settings.model.providers.empty")}</p>
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
      </section>

      {wizard !== null && <ProviderWizard mode={wizard} onClose={() => setWizard(null)} />}
      {pickerOpen && <ModelPickerDialog onClose={() => setPickerOpen(false)} />}

      {deleting.target !== null && (
        <ConfirmDialog
          title={t("settings.model.providers.deleteTitle")}
          subject={deleting.target.name}
          message={t(
            holdsDefault ? "settings.model.providers.deleteMessageDefault" : "settings.model.providers.deleteMessage",
          )}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => deleting.confirm(removeProvider, showSettingsError)}
          onCancel={deleting.close}
        />
      )}
    </SettingsSection>
  );
}

type ProviderCardProps = {
  provider: ProviderView;
  isDefault: boolean;
  onEdit: () => void;
  onDelete: () => void;
};

function ProviderCard({ provider, isDefault, onEdit, onDelete }: ProviderCardProps) {
  const keyState = provider.hasApiKey
    ? t("settings.model.providers.apiKeySet")
    : t("settings.model.providers.apiKeyUnset");

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

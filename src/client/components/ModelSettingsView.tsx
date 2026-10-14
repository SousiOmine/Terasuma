import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { modelProvider } from "../../shared/model";
import type { ProviderView } from "../../shared/types";
import { t } from "../i18n";
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
} from "../modelSettings";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorNotice } from "./ErrorNotice";
import { ModelPickerDialog } from "./ModelPickerDialog";
import { ProviderWizard, type WizardMode } from "./ProviderWizard";

const CARD_ACTION_CLASS =
  "rounded-lg px-2 py-1 text-xs transition hover:bg-neutral-100 dark:hover:bg-neutral-800";

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
  const [deleting, setDeleting] = useState<ProviderView | null>(null);

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

  const confirmDelete = async () => {
    const target = deleting;
    setDeleting(null);
    if (target === null) return;

    try {
      await removeProvider(target.id);
    } catch (failure) {
      showSettingsError(failure);
    }
  };

  const defaultProviderId =
    settings?.model === null || settings?.model === undefined ? null : modelProvider(settings.model);
  const holdsDefault = deleting !== null && deleting.id === defaultProviderId;

  return (
    <div class="mx-auto w-full max-w-2xl">
      <h2 class="text-base font-semibold">{t("settings.model")}</h2>

      {error !== null && (
        <div class="mt-4">
          <ErrorNotice
            error={error}
            action={
              <div class="flex shrink-0 flex-col items-end gap-1">
                {settings === null && (
                  <button type="button" onClick={reload} class="text-xs underline">
                    {t("settings.model.retry")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearSettingsError}
                  class="text-xs opacity-70 transition hover:opacity-100"
                >
                  {t("error.dismiss")}
                </button>
              </div>
            }
          />
        </div>
      )}

      <section class="mt-6 border-b border-neutral-200 pb-5 dark:border-neutral-800">
        <div class="flex items-start justify-between gap-6">
          <div class="min-w-0">
            <p class="text-sm font-medium">{t("settings.model.default.label")}</p>
            <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              {t("settings.model.default.description")}
            </p>
          </div>
          <Button
            disabled={settings === null || settings.providers.length === 0}
            onClick={() => setPickerOpen(true)}
          >
            {t("settings.model.default.change")}
          </Button>
        </div>

        <p class="mt-3 truncate text-sm">{settings?.model ?? t("settings.model.default.unset")}</p>
        {problem === "unset" && (
          <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t("settings.model.default.unsetHint")}
          </p>
        )}
        {problem === "provider-missing" && (
          <p class="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {t("settings.model.default.missingProvider")}
          </p>
        )}

        {reasoning !== null && reasoning.values.length > 0 && (
          <div class="mt-4 flex items-center justify-between gap-6 border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <div class="min-w-0">
              <p class="text-sm font-medium">{t("settings.model.reasoning.label")}</p>
              <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                {t("settings.model.reasoning.description")}
              </p>
            </div>
            <select
              value={reasoning.effort ?? ""}
              aria-label={t("settings.model.reasoning.label")}
              class="shrink-0 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-600"
              onChange={(event) =>
                void changeReasoning(event.currentTarget.value === "" ? null : event.currentTarget.value)
              }
            >
              <option value="">{t("settings.model.reasoning.default")}</option>
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
        <div class="flex items-start justify-between gap-6">
          <div class="min-w-0">
            <p class="text-sm font-medium">{t("settings.model.providers.label")}</p>
            <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              {t("settings.model.providers.description")}
            </p>
          </div>
          <Button variant="primary" onClick={() => setWizard({ kind: "add" })}>
            <IconPlus size={16} stroke={1.6} class="shrink-0" />
            {t("settings.model.providers.add")}
          </Button>
        </div>

        <div class="mt-3 space-y-2">
          {settings === null && loading ? (
            <p class="text-xs text-neutral-500 dark:text-neutral-400">{t("chat.loading")}</p>
          ) : settings === null || settings.providers.length === 0 ? (
            <p class="text-xs text-neutral-500 dark:text-neutral-400">
              {t("settings.model.providers.empty")}
            </p>
          ) : (
            settings.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                isDefault={settings.model !== null && modelProvider(settings.model) === provider.id}
                onEdit={() => setWizard({ kind: "edit", provider })}
                onDelete={() => setDeleting(provider)}
              />
            ))
          )}
        </div>
      </section>

      {wizard !== null && <ProviderWizard mode={wizard} onClose={() => setWizard(null)} />}
      {pickerOpen && <ModelPickerDialog onClose={() => setPickerOpen(false)} />}

      {deleting !== null && (
        <ConfirmDialog
          title={t("settings.model.providers.deleteTitle")}
          subject={deleting.name}
          message={t(
            holdsDefault
              ? "settings.model.providers.deleteMessageDefault"
              : "settings.model.providers.deleteMessage",
          )}
          confirmLabel={t("settings.model.providers.delete")}
          cancelLabel={t("sidebar.cancel")}
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
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
    <div class="flex items-start gap-3 rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <p class="truncate text-sm font-medium">{providerName(provider)}</p>
          {isDefault && (
            <span class="shrink-0 rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] dark:bg-neutral-800">
              {t("settings.model.providers.defaultBadge")}
            </span>
          )}
        </div>
        <p class="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
          {provider.baseUrl === null ? keyState : `${provider.baseUrl}・${keyState}`}
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <button type="button" onClick={onEdit} class={`${CARD_ACTION_CLASS} flex items-center gap-1`}>
          <IconPencil size={14} stroke={1.6} class="shrink-0" />
          {t("settings.model.providers.edit")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          class={`${CARD_ACTION_CLASS} flex items-center gap-1 text-red-600 dark:text-red-400`}
        >
          <IconTrash size={14} stroke={1.6} class="shrink-0" />
          {t("settings.model.providers.delete")}
        </button>
      </div>
    </div>
  );
}

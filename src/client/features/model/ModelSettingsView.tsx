import { IconAlertTriangle } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { useResourceOnce } from "../../hooks/useResourceOnce";
import { t } from "../../i18n";
import {
  clearSettingsError,
  isLoadingSettings,
  loadReasoning,
  modelLoadError,
  modelProblem,
  modelReasoning,
  modelResource,
  modelSettings,
  refreshModelSettings,
  saveReasoning,
  settingsError,
  showSettingsError,
} from "../../state/model";
import { setSettingsCategory } from "../../state/route";
import { Button } from "../../ui/Button";
import { SettingsSection } from "../../ui/SettingsSection";
import { LoadOrError } from "../../ui/LoadOrError";
import { INPUT_CLASS } from "../../ui/styles";
import { ModelPickerDialog } from "./ModelPickerDialog";

/**
 * 設定の「モデル」。
 *
 * どのモデルを使うかだけを置く。プロバイダの追加と API キーは「プロバイダ」にまとめてある。
 * モデルを選ぶには先にプロバイダが要るので、まだ無いときはプロバイダへの導線も出す。
 */
export function ModelSettingsView() {
  const settings = modelSettings.value;
  const problem = modelProblem.value;
  const error = settingsError.value;
  const reasoning = modelReasoning.value;
  const currentModel = settings?.model ?? null;

  const [pickerOpen, setPickerOpen] = useState(false);

  // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
  useResourceOnce(modelResource);

  useEffect(() => {
    // 思考強度はモデルごとの設定。選ばれているモデルの分だけを読む。
    if (currentModel === null) {
      modelReasoning.value = null;
      return;
    }
    void loadReasoning().catch(showSettingsError);
  }, [currentModel]);

  const reload = () => void refreshModelSettings().catch(showSettingsError);

  const changeReasoning = async (effort: string | null) => {
    try {
      await saveReasoning(effort);
    } catch (failure) {
      showSettingsError(failure);
    }
  };

  const hasProviders = settings !== null && settings.providers.length > 0;
  /** 読み込みが終わっていて、プロバイダが 1 つも無い。 */
  const noProviders = settings !== null && settings.providers.length === 0;

  return (
    <SettingsSection
      title={t("settings.model")}
      error={error}
      onDismiss={clearSettingsError}
      onRetry={settings === null ? reload : undefined}
    >
      <section class="mt-6">
        <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div class="min-w-0">
            <p class="text-sm font-medium">{t("settings.model.default.label")}</p>
            <p class="mt-0.5 text-xs text-secondary">{t("settings.model.default.description")}</p>
          </div>
          <Button disabled={!hasProviders} onClick={() => setPickerOpen(true)}>
            {t("settings.model.default.change")}
          </Button>
        </div>

        {settings === null ? (
          <LoadOrError loading={isLoadingSettings.value} error={modelLoadError.value} />
        ) : (
          <p class="mt-3 truncate font-mono text-[13px]">{settings.model ?? t("settings.model.default.unset")}</p>
        )}
        {problem === "unset" && <p class="mt-1 text-xs text-secondary">{t("settings.model.default.unsetHint")}</p>}
        {problem === "provider-missing" && (
          <p class="mt-1 flex items-center gap-1.5 text-xs font-medium text-primary">
            <IconAlertTriangle size={14} stroke={1.8} class="shrink-0" />
            {t("settings.model.default.missingProvider")}
          </p>
        )}
        {noProviders && (
          <button
            type="button"
            onClick={() => setSettingsCategory("providers")}
            class="mt-2 text-xs font-medium underline underline-offset-2"
          >
            {t("settings.model.default.openProviders")}
          </button>
        )}

        {reasoning !== null && reasoning.values.length > 0 && (
          <div class="mt-4 flex flex-col items-start gap-3 border-t border-stroke pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div class="min-w-0">
              <p class="text-sm font-medium">{t("settings.model.reasoning.label")}</p>
              <p class="mt-0.5 text-xs text-secondary">{t("settings.model.reasoning.description")}</p>
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

      {pickerOpen && <ModelPickerDialog onClose={() => setPickerOpen(false)} />}
    </SettingsSection>
  );
}

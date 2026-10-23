import { IconChevronRight } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { modelId } from "../../../shared/model";
import { trimOrNull } from "../../../shared/strings";
import type { EndpointPreset } from "../../../shared/providers";
import type { ProviderCredentials, ProviderView } from "../../../shared/types";
import { toErrorState, type ErrorState } from "../../lib/errors";
import { t } from "../../i18n";
import {
  addProvider,
  checkProvider,
  fetchCatalogModels,
  modelSettings,
  providers,
  updateProvider,
} from "../../state/model";
import { Button } from "../../ui/Button";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { Field } from "../../ui/Field";
import { Modal } from "../../ui/Modal";
import { SecretInput } from "../../ui/SecretInput";
import { INPUT_CLASS } from "../../ui/styles";
import { useInFlight } from "../../hooks/useInFlight";
import { ProviderChooser, presetName } from "./ProviderChooser";
import { isEndpoint, nextCustomEndpointId, pickModel, targetOf, type Target } from "./providerForm";
import { ModelList } from "./ModelList";

/** 新しく追加するか、設定済みのものを変更するか。 */
export type WizardMode = { kind: "add" } | { kind: "edit"; provider: ProviderView };

export type ProviderWizardProps = {
  mode: WizardMode;
  onClose: () => void;
};

/** 追加・変更の対象。カタログのプロバイダか、接続先を自分で決めるエンドポイントか。 */
const ADD_STEPS = [
  { key: "settings.wizard.step.choose" },
  { key: "settings.wizard.step.connect" },
  { key: "settings.wizard.step.model" },
] as const;

/**
 * プロバイダを追加するウィザード。
 *
 * 追加は「選ぶ → 接続を確認する → 使うモデルを選ぶ」の 3 段。
 * プロバイダの一覧とモデルの一覧は models.dev のカタログから取る。
 * 接続を確認できないプロバイダ（/models を公開していないもの）も、その旨を出したうえで追加できる。
 * 変更は接続情報の 1 段だけ（モデルの選び直しは「既定のモデル」から行う）。
 */
export function ProviderWizard({ mode, onClose }: ProviderWizardProps) {
  const editing = mode.kind === "edit";

  const [target, setTarget] = useState<Target | null>(() => (mode.kind === "edit" ? targetOf(mode.provider) : null));
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(() => (editing ? (mode.provider.baseUrl ?? "") : ""));
  const [label, setLabel] = useState(() => (editing && isEndpoint(mode.provider) ? mode.provider.name : ""));
  const [models, setModels] = useState<readonly string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [makeDefault, setMakeDefault] = useState(true);
  /** 接続を確かめられなかった理由（確認できたときは null）。 */
  const [checkNote, setCheckNote] = useState<"skipped" | null>(null);
  const [busy, setBusy] = useState<"checking" | "saving" | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);

  const currentDefault = modelSettings.value?.model ?? null;
  const step = stepOf(target, models);

  // 状態の更新は描画を挟むため、素早く二度押しされると busy が立つ前に 2 回目が走る。
  // 押した瞬間に閉じる門は hooks に置いてある。
  const inFlight = useInFlight();

  const needsKey = target !== null && target.kind === "catalog" && !editing;
  const needsBaseUrl = target !== null && target.kind === "endpoint";
  const incomplete = (needsKey && apiKey.trim().length === 0) || (needsBaseUrl && baseUrl.trim().length === 0);

  /** 入力中の値。空欄は「未入力」として null で送る。 */
  const credentials = (): ProviderCredentials => ({
    apiKey: trimOrNull(apiKey),
    baseUrl: trimOrNull(baseUrl),
    label: trimOrNull(label),
  });

  const selectCatalogProvider = (id: string, name: string) => {
    setTarget({ kind: "catalog", id, name });
    resetInputs();
  };

  const selectPreset = (preset: EndpointPreset) => {
    setTarget({
      kind: "endpoint",
      preset,
      id: preset.uniqueId ? nextCustomEndpointId(providers.value) : preset.id,
    });
    resetInputs();
    setBaseUrl(preset.defaultBaseUrl ?? "");
  };

  /**
   * 入力は前のプロバイダのものなので、選び直したら持ち越さない。
   * baseUrl も消す。残したままだと、カタログのプロバイダを選んでも
   * 送信時に独自エンドポイントとして扱われる（サーバは baseUrl の有無で種類を決める）。
   */
  const resetInputs = () => {
    setLabel("");
    setApiKey("");
    setBaseUrl("");
    setError(null);
  };

  const backToChoose = () => {
    setTarget(null);
    setModels(null);
    setModel(null);
    setCheckNote(null);
    setError(null);
  };

  /** 接続を確かめ、モデルの一覧を用意して次の段へ進む。 */
  const connect = async () => {
    if (target === null) return;

    setBusy("checking");
    setError(null);
    try {
      const result = await checkProvider({ id: target.id, ...credentials() });
      const found = target.kind === "catalog" ? await fetchCatalogModels(target.id) : result.models;

      if (found.length === 0) {
        // モデルを選べないと追加できない。接続の段に留めて理由を出す。
        setError({ code: "provider_no_models", detail: null });
        return;
      }

      setCheckNote(result.verified ? null : "skipped");
      setModels(found);
      setModel(pickModel(found));
    } catch (failure) {
      setError(toErrorState(failure));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (target === null) return;

    setBusy("saving");
    setError(null);
    try {
      if (editing) {
        await updateProvider(target.id, credentials());
      } else {
        await addProvider({
          id: target.id,
          ...credentials(),
          defaultModel: makeDefault && model !== null ? modelId(target.id, model) : null,
        });
      }
    } catch (failure) {
      setError(toErrorState(failure));
      setBusy(null);
      return;
    }
    onClose();
  };

  return (
    <Modal
      title={t(editing ? "settings.wizard.editTitle" : "settings.wizard.addTitle")}
      subtitle={subtitleOf(step, target)}
      size="lg"
      onClose={onClose}
      footer={footerOf({
        editing,
        step,
        busy,
        incomplete,
        canAdd: model !== null,
        onClose,
        onBack: backToChoose,
        onConnect: () => inFlight.run(connect),
        onSubmit: () => inFlight.run(submit),
        onBackToConnect: () => {
          setModels(null);
          setCheckNote(null);
        },
      })}
    >
      {!editing && <StepIndicator current={step} />}

      {step === "choose" && (
        <ProviderChooser
          onSelectCatalog={selectCatalogProvider}
          onSelectPreset={selectPreset}
          error={error}
          onError={setError}
        />
      )}

      {target !== null && step !== "choose" && (
        <div class="space-y-1">
          {target.kind === "endpoint" && target.preset.requiresLabel && (
            <Field label={t("settings.wizard.name.label")} description={t("settings.wizard.name.description")}>
              <input
                type="text"
                value={label}
                placeholder={t("settings.wizard.name.placeholder")}
                aria-label={t("settings.wizard.name.label")}
                class={INPUT_CLASS}
                onInput={(event) => setLabel(event.currentTarget.value)}
              />
            </Field>
          )}

          {target.kind === "endpoint" && (
            <Field label={t("settings.wizard.baseUrl.label")} description={t("settings.wizard.baseUrl.description")}>
              <input
                type="text"
                value={baseUrl}
                autocomplete="off"
                spellcheck={false}
                aria-label={t("settings.wizard.baseUrl.label")}
                class={INPUT_CLASS}
                onInput={(event) => setBaseUrl(event.currentTarget.value)}
              />
            </Field>
          )}

          <Field label={t("settings.wizard.apiKey.label")} hint={apiKeyHint(editing, target)}>
            <SecretInput
              value={apiKey}
              label={t("settings.wizard.apiKey.label")}
              placeholder={t("settings.wizard.apiKey.placeholder")}
              showLabel={t("settings.wizard.apiKey.show")}
              hideLabel={t("settings.wizard.apiKey.hide")}
              onInput={setApiKey}
            />
          </Field>

          {target.kind === "catalog" && <p class="pt-1 text-xs text-secondary">{t("settings.wizard.catalogHint")}</p>}

          {error !== null && (
            <div class="pt-2">
              <ErrorNotice error={error} />
            </div>
          )}
        </div>
      )}

      {step === "model" && models !== null && (
        <div class="space-y-3">
          {checkNote === "skipped" && (
            <p class="rounded-[16px] bg-surface-alt px-4 py-3 text-xs leading-5 text-secondary">
              {t("settings.wizard.checkSkipped")}
            </p>
          )}

          <ModelList models={models} value={model} onChange={setModel} />

          <label class="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={makeDefault || currentDefault === null}
              disabled={currentDefault === null}
              class="mt-0.5"
              onChange={(event) => setMakeDefault(event.currentTarget.checked)}
            />
            <span class="min-w-0">
              {t("settings.wizard.model.setDefault")}
              {currentDefault === null && (
                <span class="mt-0.5 block text-secondary">{t("settings.wizard.model.alwaysDefault")}</span>
              )}
            </span>
          </label>

          {error !== null && <ErrorNotice error={error} />}
        </div>
      )}
    </Modal>
  );
}

function subtitleOf(step: "choose" | "connect" | "model", target: Target | null): string {
  if (step === "choose") return t("settings.wizard.chooseDescription");
  if (step === "model") return t("settings.wizard.model.description");
  if (target === null) return t("settings.wizard.chooseDescription");

  return target.kind === "catalog" ? target.name : presetName(target.preset);
}

function apiKeyHint(editing: boolean, target: Target): string | undefined {
  if (editing) return t("settings.wizard.apiKey.keep");
  return target.kind === "endpoint" ? t("settings.wizard.apiKey.optional") : undefined;
}

type FooterOptions = {
  editing: boolean;
  step: "choose" | "connect" | "model";
  busy: "checking" | "saving" | null;
  incomplete: boolean;
  canAdd: boolean;
  onClose: () => void;
  onBack: () => void;
  onConnect: () => void;
  onSubmit: () => void;
  onBackToConnect: () => void;
};

/** いまの段階。対象を選んでいなければ choose、接続が確かめられていなければ connect、その先が model。 */
type WizardStep = "choose" | "connect" | "model";

function stepOf(target: Target | null, models: readonly string[] | null): WizardStep {
  if (target === null) return "choose";
  return models === null ? "connect" : "model";
}

function footerOf(options: FooterOptions) {
  const { editing, step, busy, incomplete, canAdd } = options;

  if (editing) {
    return (
      <>
        <Button onClick={options.onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={busy !== null || incomplete} onClick={options.onSubmit}>
          {t(busy === null ? "settings.wizard.save" : "common.saving")}
        </Button>
      </>
    );
  }

  if (step === "choose") {
    return <Button onClick={options.onClose}>{t("common.cancel")}</Button>;
  }

  if (step === "connect") {
    return (
      <>
        <Button onClick={options.onBack}>{t("settings.wizard.back")}</Button>
        <Button variant="primary" disabled={busy !== null || incomplete} onClick={options.onConnect}>
          {t(busy === null ? "common.check" : "common.checking")}
        </Button>
      </>
    );
  }

  return (
    <>
      <Button onClick={options.onBackToConnect}>{t("settings.wizard.back")}</Button>
      <Button variant="primary" disabled={busy !== null || !canAdd} onClick={options.onSubmit}>
        {t(busy === null ? "common.add" : "common.adding")}
      </Button>
    </>
  );
}

function StepIndicator({ current }: { current: "choose" | "connect" | "model" }) {
  const index = ADD_STEPS.findIndex((item) => item.key === `settings.wizard.step.${current}`);

  return (
    <ol class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-secondary">
      {ADD_STEPS.map((item, position) => (
        <li key={item.key} class="flex items-center gap-2">
          <span class={position <= index ? "font-medium text-[var(--app-accent-ink)]" : undefined}>
            {position + 1}. {t(item.key)}
          </span>
          {position < ADD_STEPS.length - 1 && <IconChevronRight size={12} stroke={1.6} class="shrink-0" />}
        </li>
      ))}
    </ol>
  );
}

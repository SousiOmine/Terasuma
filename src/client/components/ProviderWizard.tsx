import { useRef, useState } from "preact/hooks";
import type { ModelId } from "../../shared/model";
import {
  findProviderCatalogEntry,
  OPENAI_COMPATIBLE_TEMPLATE,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
} from "../../shared/providers";
import type { ProviderCredentials, ProviderView } from "../../shared/types";
import * as api from "../api";
import { toErrorState, type ErrorState } from "../errors";
import { t } from "../i18n";
import { addProvider, modelSettings, providers, updateProvider } from "../modelSettings";
import { providerName } from "../providerText";
import { Button } from "./Button";
import { ErrorNotice } from "./ErrorNotice";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { ModelList } from "./ModelList";

/** 新しく追加するか、設定済みのものを変更するか。 */
export type WizardMode = { kind: "add" } | { kind: "edit"; provider: ProviderView };

export type ProviderWizardProps = {
  mode: WizardMode;
  onClose: () => void;
};

const ADD_STEPS = [
  { key: "settings.wizard.step.choose" },
  { key: "settings.wizard.step.connect" },
  { key: "settings.wizard.step.model" },
] as const;

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-600";

/**
 * プロバイダを追加するウィザード。
 *
 * 追加は「選ぶ → 接続を確認する → 使うモデルを選ぶ」の 3 段。
 * 接続を確認できて初めて保存へ進めるので、設定に残るのは必ず疎通したプロバイダだけになる。
 * 変更は接続情報の 1 段だけ（モデルの選び直しは「既定のモデル」から行う）。
 */
export function ProviderWizard({ mode, onClose }: ProviderWizardProps) {
  const editing = mode.kind === "edit";
  // 変更のときは、設定済みの id からカタログの項目を引く。引けないものは独自エンドポイント。
  const template = editing ? findProviderCatalogEntry(mode.provider.id) ?? OPENAI_COMPATIBLE_TEMPLATE : null;

  const [target, setTarget] = useState<{ entry: ProviderCatalogEntry; id: string } | null>(() =>
    editing && template !== null ? { entry: template, id: mode.provider.id } : null,
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(() => (editing ? mode.provider.baseUrl ?? "" : ""));
  const [label, setLabel] = useState(() =>
    editing && template !== null && needsLabel(template) ? mode.provider.name : "",
  );
  const [revealKey, setRevealKey] = useState(false);
  const [models, setModels] = useState<readonly string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [makeDefault, setMakeDefault] = useState(true);
  const [busy, setBusy] = useState<"checking" | "saving" | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);

  const currentDefault = modelSettings.value?.model ?? null;
  const step: "choose" | "connect" | "model" = target === null ? "choose" : models === null ? "connect" : "model";

  /**
   * 送信中の要求。状態の更新は描画を挟むため、素早く二度押しされると
   * busy が立つ前に 2 回目が走ってしまう。押した瞬間に閉じる門をここに置く。
   */
  const inFlight = useRef(false);

  const run = (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    void action().finally(() => {
      inFlight.current = false;
    });
  };

  const needsKey = target !== null && target.entry.requiresApiKey && !editing;
  const needsBaseUrl = target !== null && target.entry.kind === "openai-compatible";
  const incomplete = (needsKey && apiKey.trim().length === 0) || (needsBaseUrl && baseUrl.trim().length === 0);

  /** 入力中の値。空欄は「未入力」として null で送る。 */
  const credentials = (): ProviderCredentials => ({
    apiKey: trimmedOrNull(apiKey),
    baseUrl: trimmedOrNull(baseUrl),
    label: trimmedOrNull(label),
  });

  const selectProvider = (entry: ProviderCatalogEntry) => {
    setTarget({ entry, id: needsLabel(entry) ? nextCustomEndpointId(providers.value) : entry.id });
    setBaseUrl(entry.kind === "openai-compatible" ? entry.defaultBaseUrl ?? "" : "");
    // 入力は前のプロバイダのものなので、選び直したら持ち越さない。
    setLabel("");
    setApiKey("");
    setRevealKey(false);
    setError(null);
  };

  const backToChoose = () => {
    setTarget(null);
    setModels(null);
    setModel(null);
    setError(null);
  };

  const connect = async () => {
    if (target === null) return;

    setBusy("checking");
    setError(null);
    try {
      const found = await api.checkProvider({ id: target.id, ...credentials() });
      setModels(found);
      setModel(pickModel(target.entry, found));
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
          defaultModel: makeDefault && model !== null ? fullModelId(target.id, model) : null,
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
        onConnect: () => run(connect),
        onSubmit: () => run(submit),
        onBackToConnect: () => setModels(null),
      })}
    >
      {!editing && <StepIndicator current={step} />}

      {step === "choose" && (
        <ul class="grid grid-cols-2 gap-1">
          {PROVIDER_CATALOG.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => selectProvider(entry)}
                class="w-full truncate rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm transition hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-600 dark:hover:bg-neutral-800/50"
              >
                {providerName(entry)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {target !== null && step !== "choose" && (
        <div class="space-y-1">
          {needsLabel(target.entry) && (
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

          {target.entry.kind === "openai-compatible" && (
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

          <Field label={t("settings.wizard.apiKey.label")} hint={apiKeyHint(editing, target.entry)}>
            <div class="flex items-center gap-2">
              <ApiKeyInput value={apiKey} reveal={revealKey} onInput={setApiKey} />
              <button
                type="button"
                onClick={() => setRevealKey(!revealKey)}
                class="shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                {t(revealKey ? "settings.wizard.apiKey.hide" : "settings.wizard.apiKey.show")}
              </button>
            </div>

            {target.entry.keyUrl !== null && (
              <a
                href={target.entry.keyUrl}
                target="_blank"
                rel="noreferrer"
                class="mt-1.5 inline-block text-xs text-neutral-600 underline dark:text-neutral-300"
              >
                {t("settings.wizard.keyUrl")}
              </a>
            )}
          </Field>

          {error !== null && (
            <div class="pt-2">
              <ErrorNotice error={error} />
            </div>
          )}
        </div>
      )}

      {step === "model" && models !== null && (
        <div class="space-y-3">
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
                <span class="mt-0.5 block text-neutral-500 dark:text-neutral-400">
                  {t("settings.wizard.model.alwaysDefault")}
                </span>
              )}
            </span>
          </label>

          {error !== null && <ErrorNotice error={error} />}
        </div>
      )}
    </Modal>
  );
}

function subtitleOf(step: "choose" | "connect" | "model", target: { entry: ProviderCatalogEntry } | null): string {
  if (step === "choose") return t("settings.wizard.chooseDescription");
  if (step === "model") return t("settings.wizard.model.description");
  return target === null ? t("settings.wizard.chooseDescription") : providerName(target.entry);
}

function apiKeyHint(editing: boolean, entry: ProviderCatalogEntry): string | undefined {
  if (editing) return t("settings.wizard.apiKey.keep");
  return entry.requiresApiKey ? undefined : t("settings.wizard.apiKey.optional");
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

function footerOf(options: FooterOptions) {
  const { editing, step, busy, incomplete, canAdd } = options;

  if (editing) {
    return (
      <>
        <Button onClick={options.onClose}>{t("settings.wizard.cancel")}</Button>
        <Button variant="primary" disabled={busy !== null || incomplete} onClick={options.onSubmit}>
          {t(busy === null ? "settings.wizard.save" : "settings.wizard.saving")}
        </Button>
      </>
    );
  }

  if (step === "choose") {
    return <Button onClick={options.onClose}>{t("settings.wizard.cancel")}</Button>;
  }

  if (step === "connect") {
    return (
      <>
        <Button onClick={options.onBack}>{t("settings.wizard.back")}</Button>
        <Button variant="primary" disabled={busy !== null || incomplete} onClick={options.onConnect}>
          {t(busy === null ? "settings.wizard.connect" : "settings.wizard.connecting")}
        </Button>
      </>
    );
  }

  return (
    <>
      <Button onClick={options.onBackToConnect}>{t("settings.wizard.back")}</Button>
      <Button variant="primary" disabled={busy !== null || !canAdd} onClick={options.onSubmit}>
        {t(busy === null ? "settings.wizard.add" : "settings.wizard.adding")}
      </Button>
    </>
  );
}

function StepIndicator({ current }: { current: "choose" | "connect" | "model" }) {
  const index = ADD_STEPS.findIndex((item) => item.key === `settings.wizard.step.${current}`);

  return (
    <ol class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
      {ADD_STEPS.map((item, position) => (
        <li key={item.key} class="flex items-center gap-2">
          <span class={position <= index ? "font-medium text-neutral-900 dark:text-neutral-100" : undefined}>
            {position + 1}. {t(item.key)}
          </span>
          {position < ADD_STEPS.length - 1 && <span aria-hidden="true">›</span>}
        </li>
      ))}
    </ol>
  );
}

/** 表示の切り替えができる API キーの入力欄。 */
function ApiKeyInput({
  value,
  reveal,
  onInput,
}: {
  value: string;
  reveal: boolean;
  onInput: (value: string) => void;
}) {
  const common = {
    value,
    autocomplete: "off",
    spellcheck: false,
    "aria-label": t("settings.wizard.apiKey.label"),
    placeholder: t("settings.wizard.apiKey.placeholder"),
    class: `${INPUT_CLASS} flex-1`,
    onInput: (event: { currentTarget: HTMLInputElement }) => onInput(event.currentTarget.value),
  };

  // type は文字列で切り替えず、要素ごとに分ける（型が属性ごとの union で定義されているため）。
  return reveal ? <input type="text" {...common} /> : <input type="password" {...common} />;
}

/** 名前を付けて保存するエンドポイントかどうか。 */
function needsLabel(entry: ProviderCatalogEntry): boolean {
  return entry.kind === "openai-compatible" && entry.requiresLabel;
}

/** 追加する独自エンドポイントの id。設定済みと重ならない番号を選ぶ。 */
function nextCustomEndpointId(used: readonly ProviderView[]): string {
  const ids = new Set(used.map((provider) => provider.id));
  for (let index = 1; ; index += 1) {
    const candidate = `custom-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

/** 一覧の中から最初に選ぶモデル。プロバイダごしの推奨が一覧にあれば、それを使う。 */
function pickModel(entry: ProviderCatalogEntry, models: readonly string[]): string | null {
  const preferred = entry.preferredModels.find((candidate) => models.includes(candidate));
  return preferred ?? models[0] ?? null;
}

function fullModelId(providerId: string, model: string): ModelId {
  return `${providerId}/${model}`;
}

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

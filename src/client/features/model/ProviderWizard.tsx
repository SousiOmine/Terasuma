import { IconChevronRight, IconSearch } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { modelId } from "../../../shared/model";
import { trimOrNull } from "../../../shared/strings";
import {
  ENDPOINT_PRESETS,
  OPENAI_COMPATIBLE_TEMPLATE,
  findEndpointPreset,
  type EndpointPreset,
} from "../../../shared/providers";
import type { CatalogProviderView, ProviderCredentials, ProviderView } from "../../../shared/types";
import * as api from "../../lib/api";
import { toErrorState, type ErrorState } from "../../lib/errors";
import { t } from "../../i18n";
import {
  addProvider,
  catalogProviders,
  loadCatalog,
  modelSettings,
  providers,
  updateProvider,
} from "../../state/model";
import { Button } from "../../ui/Button";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { Field } from "../../ui/Field";
import { Modal } from "../../ui/Modal";
import { ModelList } from "./ModelList";

/** 新しく追加するか、設定済みのものを変更するか。 */
export type WizardMode = { kind: "add" } | { kind: "edit"; provider: ProviderView };

export type ProviderWizardProps = {
  mode: WizardMode;
  onClose: () => void;
};

/** 追加・変更の対象。カタログのプロバイダか、接続先を自分で決めるエンドポイントか。 */
type Target = { kind: "catalog"; id: string; name: string } | { kind: "endpoint"; preset: EndpointPreset; id: string };

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
  const [revealKey, setRevealKey] = useState(false);
  const [models, setModels] = useState<readonly string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [makeDefault, setMakeDefault] = useState(true);
  /** 接続を確かめられなかった理由（確認できたときは null）。 */
  const [checkNote, setCheckNote] = useState<"skipped" | null>(null);
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
    setRevealKey(false);
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
      const result = await api.checkProvider({ id: target.id, ...credentials() });
      const found = target.kind === "catalog" ? await api.fetchCatalogModels(target.id) : result.models;

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
        onConnect: () => run(connect),
        onSubmit: () => run(submit),
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
          </Field>

          {target.kind === "catalog" && (
            <p class="pt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("settings.wizard.catalogHint")}</p>
          )}

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
            <p class="rounded-lg border border-neutral-200 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
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

/**
 * 選択肢の 1 件。
 * カタログのプロバイダと、接続先を自分で決めるエンドポイント（Ollama など）を同じ並びに置く。
 */
type ChooserEntry =
  | { kind: "catalog"; id: string; name: string; models: number }
  | { kind: "endpoint"; preset: EndpointPreset; id: string; name: string; models: null };

/** カタログの並び（名前順）に、接続先を自分で決めるものを混ぜる。 */
function chooserEntries(catalog: readonly CatalogProviderView[] | null): readonly ChooserEntry[] {
  const entries: ChooserEntry[] = [
    ...(catalog ?? []).map((provider) => ({
      kind: "catalog" as const,
      id: provider.id,
      name: provider.name,
      models: provider.models,
    })),
    ...ENDPOINT_PRESETS.map((preset) => ({
      kind: "endpoint" as const,
      preset,
      id: preset.id,
      name: presetName(preset),
      models: null,
    })),
  ];

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/** プロバイダを選ぶ段。カタログの一覧を絞り込みながら選ぶ。 */
function ProviderChooser({
  onSelectCatalog,
  onSelectPreset,
  error,
  onError,
}: {
  onSelectCatalog: (id: string, name: string) => void;
  onSelectPreset: (preset: EndpointPreset) => void;
  error: ErrorState | null;
  onError: (error: ErrorState | null) => void;
}) {
  const [query, setQuery] = useState("");
  const list = catalogProviders.value;

  useEffect(() => {
    if (catalogProviders.value !== null) return;

    void loadCatalog().catch((failure: unknown) => onError(toErrorState(failure)));
  }, []);

  const keyword = query.trim().toLowerCase();
  const visible = chooserEntries(list).filter(
    (entry) => keyword.length === 0 || entry.name.toLowerCase().includes(keyword) || entry.id.includes(keyword),
  );

  return (
    <div class="space-y-3">
      <div class="relative">
        <IconSearch
          size={16}
          stroke={1.6}
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
        />
        <input
          type="search"
          value={query}
          placeholder={t("settings.wizard.search")}
          aria-label={t("settings.wizard.search")}
          class="w-full rounded-lg border border-neutral-300 bg-white py-1.5 pl-8 pr-3 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-600"
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {error !== null && <ErrorNotice error={error} />}

      <div class="max-h-80 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        {list === null ? (
          <p class="px-3 py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">{t("chat.loading")}</p>
        ) : visible.length === 0 ? (
          <p class="px-3 py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
            {t("settings.wizard.noMatch")}
          </p>
        ) : (
          <ul class="p-1">
            {visible.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`}>
                <button
                  type="button"
                  onClick={() =>
                    entry.kind === "catalog" ? onSelectCatalog(entry.id, entry.name) : onSelectPreset(entry.preset)
                  }
                  class="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <span class="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.models !== null && (
                    <span class="shrink-0 text-[11px] text-neutral-400 dark:text-neutral-500">{entry.models}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 設定済みのプロバイダから、変更フォームの対象を決める。 */
function targetOf(provider: ProviderView): Target {
  if (provider.baseUrl === null) return { kind: "catalog", id: provider.id, name: provider.name };

  return { kind: "endpoint", preset: findEndpointPreset(provider.id) ?? OPENAI_COMPATIBLE_TEMPLATE, id: provider.id };
}

/** 接続先を自分で決めるエンドポイントかどうか。 */
function isEndpoint(provider: ProviderView): boolean {
  return provider.baseUrl !== null;
}

/** 雛形の表示名。Ollama のような固有名詞はそのまま出す。 */
function presetName(preset: EndpointPreset): string {
  return preset.id === OPENAI_COMPATIBLE_TEMPLATE.id ? t("provider.custom.name") : preset.name;
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
          {position < ADD_STEPS.length - 1 && <IconChevronRight size={12} stroke={1.6} class="shrink-0" />}
        </li>
      ))}
    </ol>
  );
}

/** 表示の切り替えができる API キーの入力欄。 */
function ApiKeyInput({ value, reveal, onInput }: { value: string; reveal: boolean; onInput: (value: string) => void }) {
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

/** 追加する独自エンドポイントの id。設定済みと重ならない番号を選ぶ。 */
function nextCustomEndpointId(used: readonly ProviderView[]): string {
  const ids = new Set(used.map((provider) => provider.id));
  for (let index = 1; ; index += 1) {
    const candidate = `custom-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

/** 一覧の中から最初に選ぶモデル。 */
function pickModel(models: readonly string[]): string | null {
  return models[0] ?? null;
}

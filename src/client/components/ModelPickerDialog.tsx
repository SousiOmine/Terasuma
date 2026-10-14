import { useEffect, useRef, useState } from "preact/hooks";
import { modelProvider, type ModelId } from "../../shared/model";
import * as api from "../api";
import { toErrorState, type ErrorState } from "../errors";
import { t } from "../i18n";
import { modelSettings, providerName, providers, saveDefaultModel } from "../modelSettings";
import { Button } from "./Button";
import { ErrorNotice } from "./ErrorNotice";
import { Modal } from "./Modal";
import { ModelList } from "./ModelList";

export type ModelPickerDialogProps = {
  onClose: () => void;
};

/**
 * 既定のモデルを選び直すダイアログ。
 * 一覧はそのつどプロバイダから取り直すので、いま使えるモデルだけが並ぶ。
 */
export function ModelPickerDialog({ onClose }: ModelPickerDialogProps) {
  const list = providers.value;
  const [activeId, setActiveId] = useState(() => list[0]?.id ?? "");
  const [models, setModels] = useState<readonly string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);

  /** 切り替えが速いときに、古い応答で上書きしないための番号。 */
  const requestRef = useRef(0);

  /** 二度押しで同じ要求を 2 回送らないための門。 */
  const inFlight = useRef(false);

  const run = (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    void action().finally(() => {
      inFlight.current = false;
    });
  };

  const load = async (providerId: string) => {
    const request = (requestRef.current += 1);
    setLoading(true);
    setError(null);
    setModels(null);

    try {
      const found = await api.listProviderModels(providerId);
      if (requestRef.current !== request) return;

      setModels(found);
      setModel(currentModelOf(providerId, found) ?? found[0] ?? null);
    } catch (failure) {
      if (requestRef.current !== request) return;
      setError(toErrorState(failure));
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  };

  useEffect(() => {
    if (activeId.length === 0) return;
    void load(activeId);
  }, [activeId]);

  const save = async () => {
    if (activeId.length === 0 || model === null) return;

    setBusy(true);
    setError(null);
    try {
      await saveDefaultModel(`${activeId}/${model}` as ModelId);
    } catch (failure) {
      setError(toErrorState(failure));
      setBusy(false);
      return;
    }
    onClose();
  };

  return (
    <Modal
      title={t("settings.model.picker.title")}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("sidebar.cancel")}</Button>
          <Button variant="primary" disabled={busy || model === null} onClick={() => run(save)}>
            {t(busy ? "settings.model.picker.saving" : "settings.model.picker.confirm")}
          </Button>
        </>
      }
    >
      {list.length > 1 && (
        <div class="mb-3 flex flex-wrap gap-1">
          {list.map((provider) => {
            const active = provider.id === activeId;
            return (
              <button
                key={provider.id}
                type="button"
                aria-pressed={active}
                onClick={() => setActiveId(provider.id)}
                class={`rounded-lg px-2.5 py-1 text-xs transition ${
                  active
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                {providerName(provider)}
              </button>
            );
          })}
        </div>
      )}

      {error !== null && (
        <div class="mb-3">
          <ErrorNotice
            error={error}
            action={
              <button
                type="button"
                onClick={() => void load(activeId)}
                class="shrink-0 text-xs underline"
              >
                {t("settings.wizard.retry")}
              </button>
            }
          />
        </div>
      )}

      {loading ? (
        <p class="py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
          {t("settings.model.loadingModels")}
        </p>
      ) : (
        models !== null && (
          <ModelList
            models={models}
            value={model}
            onChange={setModel}
            currentModel={currentModelOf(activeId, models)}
          />
        )
      )}
    </Modal>
  );
}

/** いま既定になっているモデル。このプロバイダのものでなければ null。 */
function currentModelOf(providerId: string, models: readonly string[]): string | null {
  const current = modelSettings.value?.model;
  if (current === undefined || current === null) return null;
  if (modelProvider(current) !== providerId) return null;

  const id = current.slice(providerId.length + 1);
  return models.includes(id) ? id : null;
}

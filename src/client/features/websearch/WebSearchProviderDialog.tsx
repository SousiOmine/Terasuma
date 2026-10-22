import { useEffect, useRef, useState } from "preact/hooks";
import { trimOrNull } from "../../../shared/strings";
import type {
  WebSearchAvailableProviderView,
  WebSearchProviderForm,
  WebSearchProviderView,
} from "../../../shared/types";
import { useInFlight } from "../../hooks/useInFlight";
import { t } from "../../i18n";
import * as api from "../../lib/api";
import { type ErrorState, toErrorState } from "../../lib/errors";
import { addWebSearchProvider, updateWebSearchProvider } from "../../state/websearch";
import { Button } from "../../ui/Button";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { Field } from "../../ui/Field";
import { Modal } from "../../ui/Modal";
import { INPUT_CLASS } from "../../ui/styles";

/** 新しく追加するか、設定済みのものを変更するか。 */
export type WebSearchDialogMode =
  | { kind: "add"; available: readonly WebSearchAvailableProviderView[] }
  | { kind: "edit"; provider: WebSearchProviderView };

/** 確かめられたときの入力と、そのときに返ってきた検索の件数。 */
type Checked = { signature: string; results: number };

/**
 * 検索プロバイダを追加・変更するダイアログ。
 *
 * 追加は「選ぶ → API キーを入れる → 接続を確認 → 追加する」の順に進める。
 * 検索できることを確かめるまで追加できない（間違ったキーを保存すると、
 * エージェントが検索するたびに失敗するため）。
 *
 * 変更は API キーの差し替えだけにして、確かめるのは保存の後（次のターンで分かる）。
 * 空欄のまま保存すると、保存済みのキーを使い続ける。
 */
export function WebSearchProviderDialog({ mode, onClose }: { mode: WebSearchDialogMode; onClose: () => void }) {
  const editing = mode.kind === "edit";
  const provider = editing ? mode.provider : null;
  const choices = editing ? [] : mode.available;

  const [providerId, setProviderId] = useState(editing ? mode.provider.id : (mode.available[0]?.id ?? ""));
  const [apiKey, setApiKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [busy, setBusy] = useState<"checking" | "saving" | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  /** 確かめたが検索できなかった理由。 */
  const [failureDetail, setFailureDetail] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);

  /** 送信中の要求。素早く二度押しされると busy が立つ前に 2 回目が走るので、押した瞬間に閉じる門を置く。 */
  const inFlight = useInFlight();
  /** 走っている確認の番号。入力が変わったときと閉じたときに進めて、その結果を捨てる。 */
  const run = useRef(0);

  const selected = editing ? provider : (choices.find((choice) => choice.id === providerId) ?? null);
  /** 入力そのもの。確かめた結果が今の入力に対するものかを比べるのにも使う。 */
  const signature = JSON.stringify({ id: providerId, apiKey: apiKey.trim() });
  const checkedNow = checked !== null && checked.signature === signature ? checked : null;

  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  /** 入力が変わったら、確かめた結果は捨てる（別のプロバイダ・別のキーを確かめることになるため）。 */
  const change = <T,>(set: (value: T) => void, value: T): void => {
    set(value);
    setChecked(null);
    setFailureDetail(null);
    setError(null);
    run.current += 1;
  };

  /** いまの入力で検索できるか確かめる。設定には何も書かない。 */
  const check = () => {
    if (inFlight.isRunning()) return;

    const key = apiKey.trim();
    if (key.length === 0) {
      setError({ code: "input", detail: t("settings.webSearch.form.needKey") });
      return;
    }

    inFlight.run(async () => {
      setBusy("checking");
      setError(null);
      setChecked(null);
      setFailureDetail(null);
      const current = run.current + 1;
      run.current = current;

      try {
        const result = await api.testWebSearchProvider({ id: providerId, apiKey: key });
        if (run.current !== current) return;

        if (result.ok) {
          setChecked({ signature, results: result.results });
        } else {
          setFailureDetail(result.detail ?? t("settings.webSearch.form.failed"));
        }
      } catch (failure) {
        if (run.current !== current) return;
        setError(toErrorState(failure));
      } finally {
        setBusy(null);
      }
    });
  };

  const submit = () => {
    if (inFlight.isRunning()) return;
    if (!editing && checkedNow === null) return;

    const form: WebSearchProviderForm = { id: providerId, apiKey: editing ? trimOrNull(apiKey) : apiKey.trim() };

    inFlight.run(async () => {
      setBusy("saving");
      setError(null);
      try {
        if (editing) await updateWebSearchProvider(form);
        else await addWebSearchProvider(form);
        onClose();
      } catch (failure) {
        setError(toErrorState(failure));
        setBusy(null);
      }
    });
  };

  return (
    <Modal
      title={t(editing ? "settings.webSearch.form.editTitle" : "settings.webSearch.form.addTitle")}
      subtitle={provider?.name}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>

          {editing ? (
            <Button variant="primary" disabled={busy !== null} onClick={submit}>
              {t(busy === "saving" ? "common.saving" : "settings.webSearch.form.save")}
            </Button>
          ) : (
            <>
              <Button disabled={busy !== null || apiKey.trim().length === 0} onClick={check}>
                {t(busy === "checking" ? "common.checking" : "common.check")}
              </Button>
              <Button variant="primary" disabled={checkedNow === null || busy !== null} onClick={submit}>
                {t(busy === "saving" ? "common.adding" : "common.add")}
              </Button>
            </>
          )}
        </>
      }
    >
      <div class="space-y-1">
        {!editing && (
          <Field
            label={t("settings.webSearch.form.provider.label")}
            description={t("settings.webSearch.form.provider.description")}
          >
            <select
              value={providerId}
              aria-label={t("settings.webSearch.form.provider.label")}
              class={INPUT_CLASS}
              onChange={(event) => change(setProviderId, event.currentTarget.value)}
            >
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
            {selected !== null && (
              <p class="mt-1.5 text-xs leading-5 text-[var(--app-text-secondary)]">
                {t(selected.supportsFetch ? "settings.webSearch.form.fetchApi" : "settings.webSearch.form.fetchDirect")}
              </p>
            )}
          </Field>
        )}

        <Field
          label={t("settings.webSearch.form.apiKey.label")}
          description={t("settings.webSearch.form.apiKey.description")}
          hint={editing ? t("settings.webSearch.form.apiKey.keep") : undefined}
        >
          <div class="flex items-center gap-2">
            <ApiKeyInput value={apiKey} reveal={revealKey} onInput={(value) => change(setApiKey, value)} />
            <button
              type="button"
              onClick={() => setRevealKey(!revealKey)}
              class="shrink-0 rounded-full px-2.5 py-1 text-xs text-[var(--app-text-secondary)] transition hover:bg-[var(--app-soft)] hover:text-[var(--app-text)]"
            >
              {t(revealKey ? "settings.webSearch.form.apiKey.hide" : "settings.webSearch.form.apiKey.show")}
            </button>
          </div>
        </Field>

        {!editing && (
          <>
            {checkedNow !== null && (
              <div class="rounded-[16px] bg-[var(--app-accent-soft)] px-4 py-3 text-xs text-[var(--app-text)]">
                {t("settings.webSearch.form.checked", { count: checkedNow.results })}
              </div>
            )}
            {failureDetail !== null && (
              <div class="rounded-[16px] bg-[var(--app-danger-soft)] px-4 py-3 text-xs text-[var(--app-text)]">
                <p class="font-medium">{t("settings.webSearch.form.failed")}</p>
                <p class="mt-1 break-words leading-5 text-[var(--app-text-secondary)]">{failureDetail}</p>
              </div>
            )}
            {checkedNow === null && failureDetail === null && (
              <p class="pt-2 text-xs text-[var(--app-text-secondary)]">{t("settings.webSearch.form.needCheck")}</p>
            )}
          </>
        )}

        {error !== null && (
          <div class="pt-2">
            <ErrorNotice error={error} />
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 表示の切り替えができる API キーの入力欄。 */
function ApiKeyInput({ value, reveal, onInput }: { value: string; reveal: boolean; onInput: (value: string) => void }) {
  const common = {
    value,
    autocomplete: "off",
    spellcheck: false,
    "aria-label": t("settings.webSearch.form.apiKey.label"),
    placeholder: t("settings.webSearch.form.apiKey.placeholder"),
    class: `${INPUT_CLASS} flex-1`,
    onInput: (event: { currentTarget: HTMLInputElement }) => onInput(event.currentTarget.value),
  };

  // type は文字列で切り替えず、要素ごとに分ける（型が属性ごとの union で定義されているため）。
  return reveal ? <input type="text" {...common} /> : <input type="password" {...common} />;
}

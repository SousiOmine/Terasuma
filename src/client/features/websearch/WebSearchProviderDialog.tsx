import { useState } from "preact/hooks";
import { trimOrNull } from "../../../shared/strings";
import type {
  WebSearchAvailableProviderView,
  WebSearchProviderForm,
  WebSearchProviderView,
} from "../../../shared/api/settings";
import { useVerifiedForm } from "../../hooks/useVerifiedForm";
import { t } from "../../i18n";
import { addWebSearchProvider, testWebSearchProvider, updateWebSearchProvider } from "../../state/websearch";
import { Button } from "../../ui/Button";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { Field } from "../../ui/Field";
import { Modal } from "../../ui/Modal";
import { SecretInput } from "../../ui/SecretInput";
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
  /** 確かめたが検索できなかった理由。 */
  const [failureDetail, setFailureDetail] = useState<string | null>(null);

  const selected = editing ? provider : (choices.find((choice) => choice.id === providerId) ?? null);
  /**
   * 入力そのもの。確かめた結果が今の入力に対するものかを比べるのにも使う。
   * 入力が変わると、useVerifiedForm が確認結果を捨てる。
   */
  const signature = JSON.stringify({ id: providerId, apiKey: apiKey.trim() });
  const form = useVerifiedForm<Checked>(signature);
  const { busy, error, checked: checkedNow } = form;

  /** 入力が変わったら、確かめた結果は捨てる（別のプロバイダ・別のキーを確かめることになるため）。 */
  const change = <T,>(set: (value: T) => void, value: T): void => {
    set(value);
    form.invalidate();
    setFailureDetail(null);
  };

  /** いまの入力で検索できるか確かめる。設定には何も書かない。 */
  const check = async (): Promise<void> => {
    const key = apiKey.trim();
    if (key.length === 0) {
      form.setError({ code: "input", detail: t("settings.webSearch.form.needKey") });
      return;
    }

    setFailureDetail(null);
    await form.check(async () => {
      const result = await testWebSearchProvider({ id: providerId, apiKey: key });
      if (result.ok) return { signature, results: result.results };

      // 検索できなかった理由は、失敗ではなく「確かめた結果」として出す（キーの誤りとは限らない）。
      setFailureDetail(result.detail ?? t("settings.webSearch.form.failed"));
      throw new Error(result.detail ?? t("settings.webSearch.form.failed"));
    });
  };

  const submit = async (): Promise<void> => {
    if (!editing && checkedNow === null) return;

    const input: WebSearchProviderForm = {
      id: providerId,
      apiKey: editing ? trimOrNull(apiKey) : apiKey.trim(),
    };
    await form.save(async () => {
      if (editing) await updateWebSearchProvider(input);
      else await addWebSearchProvider(input);
      onClose();
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
            <Button variant="primary" disabled={busy !== null} onClick={() => void submit()}>
              {t(busy === "saving" ? "common.saving" : "settings.webSearch.form.save")}
            </Button>
          ) : (
            <>
              <Button disabled={busy !== null || apiKey.trim().length === 0} onClick={() => void check()}>
                {t(busy === "checking" ? "common.checking" : "common.check")}
              </Button>
              <Button variant="primary" disabled={checkedNow === null || busy !== null} onClick={() => void submit()}>
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
              <p class="mt-1.5 text-xs leading-5 text-secondary">
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
          <SecretInput
            value={apiKey}
            label={t("settings.webSearch.form.apiKey.label")}
            placeholder={t("settings.webSearch.form.apiKey.placeholder")}
            showLabel={t("settings.webSearch.form.apiKey.show")}
            hideLabel={t("settings.webSearch.form.apiKey.hide")}
            onInput={(value) => change(setApiKey, value)}
          />
        </Field>

        {!editing && (
          <>
            {checkedNow !== null && (
              <div class="rounded-[16px] bg-[var(--app-accent-soft)] px-4 py-3 text-xs text-primary">
                {t("settings.webSearch.form.checked", { count: checkedNow.results })}
              </div>
            )}
            {failureDetail !== null && (
              <div class="rounded-[16px] bg-[var(--app-danger-soft)] px-4 py-3 text-xs text-primary">
                <p class="font-medium">{t("settings.webSearch.form.failed")}</p>
                <p class="mt-1 break-words leading-5 text-secondary">{failureDetail}</p>
              </div>
            )}
            {checkedNow === null && failureDetail === null && (
              <p class="pt-2 text-xs text-secondary">{t("settings.webSearch.form.needCheck")}</p>
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

import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n";
import {
  cancelEnvRequest,
  envRequestDescription,
  envRequestName,
  envRequestSending,
  submitEnvValue,
} from "../../state/env-request";
import { INPUT_CLASS } from "../../ui/styles";

/**
 * 環境変数の入力欄。
 *
 * エージェントが computer_set_env を呼んだとき、チャットの入力欄の上に出る。
 * 入力された値はこの部品の中と、サーバへの 1 回の POST の中だけを通る。
 * モデルへ渡る文章（ツールの引数・戻り値・履歴）には、値を一切含めない。
 *
 * 狭い画面でコンピュータの画面を全画面で開いている間も入力できるよう、
 * 同じ部品を ComputerPane にも置く（引き受けの返事と同じ扱い）。
 */
export function EnvRequestPanel() {
  const name = envRequestName.value;
  const description = envRequestDescription.value;
  const sending = envRequestSending.value;

  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 入力欄が出たら、そのまま打てるようにする。値は前の待ちのものを引き継がない。
  useEffect(() => {
    if (name === null) return;
    setValue("");
    inputRef.current?.focus();
  }, [name]);

  if (name === null) return null;

  const submit = (): void => {
    if (sending || value.trim().length === 0) return;

    // 送った値は、すぐに画面の状態から消す（失敗したら、もう一度入れてもらう）。
    const sendingValue = value;
    setValue("");
    void submitEnvValue(sendingValue);
  };

  return (
    <section class="rounded-[20px] border border-[var(--app-stroke)] bg-[var(--app-surface-alt)] p-4">
      <p class="text-[13px] font-medium">{t("chat.env.title")}</p>
      <p class="mt-1 break-all font-mono text-xs text-[var(--app-text-secondary)]">{name}</p>
      {description !== null && (
        <p class="mt-2 whitespace-pre-wrap text-xs leading-5 text-[var(--app-text-secondary)]">{description}</p>
      )}

      <form
        class="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          type="password"
          value={value}
          placeholder={t("chat.env.placeholder")}
          aria-label={t("chat.env.placeholder")}
          autocomplete="new-password"
          autocapitalize="off"
          spellcheck={false}
          disabled={sending}
          class={`${INPUT_CLASS} min-w-0 flex-1`}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <button
          type="submit"
          disabled={sending || value.trim().length === 0}
          class="shrink-0 rounded-full bg-[var(--app-accent-fill)] px-4 py-2.5 text-sm font-medium whitespace-nowrap text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)] transition hover:bg-[var(--app-accent-hover)] disabled:cursor-not-allowed disabled:opacity-30 md:py-2"
        >
          {t(sending ? "chat.env.submitting" : "chat.env.submit")}
        </button>
      </form>

      <div class="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => void cancelEnvRequest()}
          disabled={sending}
          class="shrink-0 text-[11px] font-medium text-[var(--app-text-secondary)] underline-offset-2 transition hover:text-[var(--app-text)] hover:underline disabled:opacity-50"
        >
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}

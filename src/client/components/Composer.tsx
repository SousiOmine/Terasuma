import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { isStreaming, sendMessage, stopStreaming } from "../state";

const MAX_TEXTAREA_HEIGHT = 200;

export function Composer() {
  const [draft, setDraft] = useState("");
  const streaming = isStreaming.value;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 入力に合わせて高さを伸ばす。CSS だけでは全ブラウザで揃わないため、実際の高さを測って設定する。
  useEffect(() => {
    const node = textareaRef.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [draft]);

  const submit = () => {
    const content = draft.trim();
    if (content.length === 0 || streaming) return;

    setDraft("");
    void sendMessage(content);
  };

  return (
    <div class="shrink-0 px-5 pb-5">
      <div class="mx-auto w-full max-w-3xl">
        <div class="flex items-end gap-2 rounded-2xl border border-neutral-300 bg-white px-3 py-2 shadow-sm focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-600">
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={t("composer.placeholder")}
            aria-label={t("composer.placeholder")}
            class="max-h-[200px] min-h-6 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-neutral-400"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              // 日本語入力の変換確定の Enter を送信と勘違いしないよう isComposing を見る。
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />

          {streaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              class="shrink-0 rounded-lg bg-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-300 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              {t("composer.stop")}
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim().length === 0}
              class="shrink-0 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {t("composer.send")}
            </button>
          )}
        </div>

        <p class="mt-1.5 text-center text-[11px] text-neutral-500 dark:text-neutral-400">{t("composer.hint")}</p>
      </div>
    </div>
  );
}

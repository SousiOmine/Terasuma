import { IconPlayerStopFilled, IconSend } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { isSendKey } from "../../lib/composer-keys";
import { t } from "../../i18n";
import { isStreaming, sendMessage, stopStreaming } from "../../state/chat";
import { handoverQuestion } from "../../state/handover";

const MAX_TEXTAREA_HEIGHT = 200;

export function Composer() {
  const [draft, setDraft] = useState("");
  // 引き受けている間は、送信先がツールの戻り値に変わるだけで、送信はできる。
  const streaming = isStreaming.value && handoverQuestion.value === null;
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
              // Enter と Shift + Enter は改行のままにする（送信は Ctrl / Cmd + Enter）。
              if (!isSendKey(event)) return;
              event.preventDefault();
              submit();
            }}
          />

          {streaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              title={t("composer.stop")}
              aria-label={t("composer.stop")}
              class="shrink-0 rounded-lg bg-neutral-200 p-2 text-neutral-700 transition hover:bg-neutral-300 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              <IconPlayerStopFilled size={16} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim().length === 0}
              title={t("composer.send")}
              aria-label={t("composer.send")}
              class="shrink-0 rounded-lg bg-neutral-900 p-2 text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              <IconSend size={16} stroke={1.6} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

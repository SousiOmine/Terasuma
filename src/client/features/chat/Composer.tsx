import { IconPaperclip, IconPlayerStopFilled, IconSend, IconX } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  formatBytes,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
} from "../../../shared/attachments";
import { isSendKey } from "../../lib/composer-keys";
import { ApiError } from "../../lib/http";
import { t } from "../../i18n";
import { isStreaming, sendMessage, stopStreaming } from "../../state/chat";
import { clearChatError, showChatError } from "../../state/failure";
import { handoverActive } from "../../state/handover";

const MAX_TEXTAREA_HEIGHT = 200;

export function Composer() {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  // 引き受けている間は、送信先がツールの戻り値に変わるだけで、送信はできる。
  const streaming = isStreaming.value && !handoverActive.value;
  // 画面を渡している間は、添付ではなく画面への操作が仕事になる。
  const canAttach = !handoverActive.value;
  // 引き受け中は本文だけ、ふだんは本文かファイルのどちらかがあれば送れる。
  const canSend = handoverActive.value ? draft.trim().length > 0 : draft.trim().length > 0 || files.length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 入力に合わせて高さを伸ばす。CSS だけでは全ブラウザで揃わないため、実際の高さを測って設定する。
  useEffect(() => {
    const node = textareaRef.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [draft]);

  const addFiles = (picked: readonly File[]) => {
    if (picked.length === 0) return;

    const next = [...files, ...picked];
    if (next.length > MAX_ATTACHMENTS) {
      showChatError(new ApiError("invalid_request", t("composer.attach.tooMany", { max: MAX_ATTACHMENTS })));
      return;
    }
    if (next.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      showChatError(
        new ApiError("invalid_request", t("composer.attach.tooLarge", { max: formatBytes(MAX_ATTACHMENT_BYTES) })),
      );
      return;
    }

    const total = next.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      showChatError(
        new ApiError(
          "invalid_request",
          t("composer.attach.totalTooLarge", { max: formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES) }),
        ),
      );
      return;
    }

    clearChatError();
    setFiles(next);
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, current) => current !== index));
  };

  const submit = () => {
    if (streaming || !canSend) return;
    const content = draft.trim();

    // 引き受けている間の入力は、画面を見ている利用者からの返事になる。
    // 添付は新しい発言にだけ付けるので、ここでは送らない。
    if (handoverActive.value) {
      setDraft("");
      void sendMessage(content, []);
      return;
    }

    const sending = files;
    setDraft("");
    setFiles([]);
    void sendMessage(content, sending);
  };

  return (
    <div class="shrink-0 px-5 pb-5">
      <div class="mx-auto w-full max-w-3xl">
        {files.length > 0 && (
          <div class="mb-2 flex flex-wrap gap-1.5">
            {files.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                class="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800/60"
              >
                <span class="max-w-[220px] truncate">{file.name}</span>
                <span class="shrink-0 text-neutral-500 dark:text-neutral-400">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  title={t("composer.attach.remove", { name: file.name })}
                  aria-label={t("composer.attach.remove", { name: file.name })}
                  class="shrink-0 rounded p-0.5 text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                >
                  <IconX size={12} stroke={2} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div class="flex items-end gap-2 rounded-2xl border border-neutral-300 bg-white px-3 py-2 shadow-sm focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-600">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            class="hidden"
            onChange={(event) => {
              const input = event.currentTarget;
              addFiles(Array.from(input.files ?? []));
              // 同じファイルをもう一度選べるように、入力を空に戻す。
              input.value = "";
            }}
          />

          {canAttach && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title={t("composer.attach")}
              aria-label={t("composer.attach")}
              class="shrink-0 rounded-lg p-2 text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <IconPaperclip size={16} stroke={1.6} />
            </button>
          )}

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
              disabled={!canSend}
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

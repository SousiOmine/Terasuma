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
import { isStopping, isStreaming, sendMessage, stopStreaming } from "../../state/chat";
import { clearChatError, showChatError } from "../../state/failure";
import { handoverActive } from "../../state/handover";

const MAX_TEXTAREA_HEIGHT = 160;

export function Composer() {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  // 引き受けている間は、送信先がツールの戻り値に変わるだけで、送信はできる。
  const streaming = isStreaming.value && !handoverActive.value;
  const stopping = isStopping.value;
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
    <div class="tera-safe-bottom shrink-0 bg-[var(--app-surface)] px-3 pb-3 pt-2 sm:px-6">
      <div class="mx-auto w-full max-w-3xl">
        {files.length > 0 && (
          <div class="mb-2 flex flex-wrap gap-1.5">
            {files.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                class="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--app-soft)] px-3 py-1.5 text-xs"
              >
                <span class="max-w-[220px] truncate">{file.name}</span>
                <span class="shrink-0 text-[var(--app-text-secondary)]">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  title={t("composer.attach.remove", { name: file.name })}
                  aria-label={t("composer.attach.remove", { name: file.name })}
                  class="shrink-0 rounded-full p-0.5 text-[var(--app-text-secondary)] transition hover:bg-[var(--app-soft-strong)] hover:text-[var(--app-text)]"
                >
                  <IconX size={12} stroke={2} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div class="flex items-end gap-1.5 rounded-[28px] border border-[var(--app-stroke)] bg-[var(--app-surface-alt)] px-2 py-2 shadow-[var(--app-shadow-2)] transition focus-within:border-[var(--app-ink)] focus-within:bg-[var(--app-surface)] focus-within:shadow-[0_0_0_4px_var(--app-ring)]">
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
              class="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--app-text-secondary)] transition hover:bg-[var(--app-soft)] hover:text-[var(--app-text)] md:h-9 md:w-9"
            >
              <IconPaperclip size={18} stroke={1.7} />
            </button>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={t("composer.placeholder")}
            aria-label={t("composer.placeholder")}
            enterkeyhint="send"
            class="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1.5 py-2 text-[15px] leading-6 text-[var(--app-text)] outline-none placeholder:text-[var(--app-text-tertiary)]"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter で送信し、Shift + Enter は改行のままにする。
              if (!isSendKey(event)) return;
              event.preventDefault();
              submit();
            }}
          />

          {streaming ? (
            <button
              type="button"
              onClick={() => void stopStreaming()}
              disabled={stopping}
              title={t(stopping ? "composer.stopping" : "composer.stop")}
              aria-label={t(stopping ? "composer.stopping" : "composer.stop")}
              class="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--app-ink-fill)] text-[var(--app-on-ink)] shadow-[var(--app-shadow-2)] transition hover:bg-[var(--app-ink-hover)] disabled:opacity-50 md:h-9 md:w-9"
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
              class="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--app-ink-fill)] text-[var(--app-on-ink)] shadow-[var(--app-shadow-2)] transition hover:bg-[var(--app-ink-hover)] disabled:opacity-30 md:h-9 md:w-9"
            >
              <IconSend size={17} stroke={1.8} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

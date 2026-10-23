import { IconPaperclip, IconPlayerStopFilled, IconSend } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  formatBytes,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
} from "../../../shared/attachments";
import { isSendKey } from "../../lib/composer-keys";
import { pastedFiles } from "../../lib/composer-paste";
import { ApiError } from "../../lib/http";
import { t } from "../../i18n";
import { isStopping, isStreaming, sendMessage, stopStreaming } from "../../state/chat";
import { clearChatError, showChatError } from "../../state/failure";
import { handoverActive } from "../../state/handover";
import { ComposerAttachments } from "./ComposerAttachments";

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
  // 続けて貼り付けても前のファイルを落とさないよう、state とは別に最新の一覧を持つ。
  // state は次の描画まで古いままなので、続けて届いたイベントはこちらを見て足す。
  const filesRef = useRef<readonly File[]>([]);

  const replaceFiles = (next: readonly File[]) => {
    filesRef.current = next;
    setFiles(next);
  };

  // 入力に合わせて高さを伸ばす。CSS だけでは全ブラウザで揃わないため、実際の高さを測って設定する。
  useEffect(() => {
    const node = textareaRef.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [draft]);

  const addFiles = (picked: readonly File[]) => {
    if (picked.length === 0) return;

    const next = [...filesRef.current, ...picked];
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
    replaceFiles(next);
  };

  /**
   * 貼り付けた画像やファイルを、選んだファイルと同じ扱いで添付に回す。
   * 本文も一緒に貼り付けたときは、その文字をそのまま入れる（既定の貼り付けを止めない）。
   */
  const handlePaste = (event: ClipboardEvent) => {
    if (!canAttach || event.clipboardData === null) return;

    const pasted = pastedFiles(Array.from(event.clipboardData.files), Array.from(event.clipboardData.items));
    if (pasted.length === 0) return;

    // ファイルだけの貼り付けでは、入力欄に余計な文字を入れない。
    if (event.clipboardData.getData("text/plain").length === 0) event.preventDefault();
    addFiles(pasted);
  };

  const removeFile = (index: number) => {
    replaceFiles(filesRef.current.filter((_, current) => current !== index));
  };

  const submit = () => {
    // 停止を頼んだ直後は、止まったターンに足さない（足しても応答しない）。
    if (!canSend || stopping) return;
    const content = draft.trim();

    // 引き受けている間の入力は、画面を見ている利用者からの返事になる。
    // 添付は新しい発言にだけ付けるので、ここでは送らない。
    if (handoverActive.value) {
      setDraft("");
      void sendMessage(content, []);
      return;
    }

    const sending = filesRef.current;
    setDraft("");
    replaceFiles([]);
    void sendMessage(content, sending);
  };

  return (
    <div class="tera-safe-bottom shrink-0 bg-[var(--app-surface)] px-3 pb-3 pt-2 sm:px-6">
      <div class="mx-auto w-full max-w-3xl">
        <div class="rounded-[26px] border border-[var(--app-stroke)] bg-[var(--app-surface)] shadow-[var(--app-shadow-4)] transition focus-within:border-[var(--app-accent)] focus-within:shadow-[0_0_0_4px_var(--app-ring)]">
          {files.length > 0 && <ComposerAttachments files={files} onRemove={removeFile} />}

          <div class="flex items-end gap-1.5 px-2 py-2">
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
              placeholder={t(streaming ? "composer.placeholder.steering" : "composer.placeholder")}
              aria-label={t(streaming ? "composer.placeholder.steering" : "composer.placeholder")}
              enterkeyhint="send"
              class="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1.5 py-2 text-[15px] leading-6 text-[var(--app-text)] outline-none placeholder:text-[var(--app-text-tertiary)]"
              onInput={(event) => setDraft(event.currentTarget.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                // Enter で送信し、Shift + Enter は改行のままにする。
                if (!isSendKey(event)) return;
                event.preventDefault();
                submit();
              }}
            />

            {/* 応答中も送れる（走っているターンへ足す）。止めたいときは、その隣の停止を押す。 */}
            {streaming && (
              <button
                type="button"
                onClick={() => void stopStreaming()}
                disabled={stopping}
                title={t(stopping ? "composer.stopping" : "composer.stop")}
                aria-label={t(stopping ? "composer.stopping" : "composer.stop")}
                class="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--app-soft)] text-[var(--app-text-secondary)] transition hover:bg-[var(--app-soft-strong)] hover:text-[var(--app-text)] disabled:opacity-50 md:h-9 md:w-9"
              >
                <IconPlayerStopFilled size={14} />
              </button>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={!canSend || stopping}
              title={t("composer.send")}
              aria-label={t("composer.send")}
              class="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--app-accent-fill)] text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)] transition hover:bg-[var(--app-accent-hover)] disabled:opacity-30 md:h-9 md:w-9"
            >
              <IconSend size={17} stroke={1.8} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

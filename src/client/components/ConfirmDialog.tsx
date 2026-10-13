import { useEffect, useRef } from "preact/hooks";

export type ConfirmDialogProps = {
  /** 見出し。何を確認するのかを書く。 */
  title: string;
  /** 操作の対象。見出しの下に名前を出す。 */
  subject?: string;
  /** 取り消せないなどの補足。 */
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 取り消せない操作のとき true。確定ボタンを赤くする。 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** ダイアログの中に閉じ込める要素。 */
const FOCUSABLE = "button:not([disabled])";

/**
 * 画面の中央に出す確認ダイアログ。
 * window.confirm は埋め込み WebView の権限設定で使えないことがあるため、自前で描く。
 */
export function ConfirmDialog({
  title,
  subject,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 開いた直後はダイアログ自体へフォーカスを移し、Escape と Tab をここで受ける。
    const previous = document.activeElement;
    dialogRef.current?.focus();

    // 閉じたら元の位置へ戻す。戻さないと、キーボード操作の続きが画面の先頭からになる。
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;

    // 背景の操作へ抜けないよう、Tab はダイアログの中だけで回す。
    const dialog = dialogRef.current;
    if (dialog === null) return;

    const buttons = dialog.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (first === undefined || last === undefined) return;

    const focused = document.activeElement;
    if (event.shiftKey && (focused === first || focused === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 背景のクリックで閉じる。 */}
      <div class="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onCancel} />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        class="relative w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-5 shadow-xl outline-none dark:border-neutral-700 dark:bg-neutral-900"
      >
        <h2 class="text-sm font-semibold">{title}</h2>

        {subject !== undefined && (
          <p class="mt-3 truncate rounded-lg bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">{subject}</p>
        )}

        <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{message}</p>

        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            class={`rounded-lg px-3 py-1.5 text-sm transition ${
              danger
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

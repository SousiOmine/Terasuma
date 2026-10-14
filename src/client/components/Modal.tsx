import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/** ダイアログの中に閉じ込める要素。 */
const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]";

export type ModalProps = {
  /** 見出し。何のダイアログなのかを書く。 */
  title: string;
  /** 見出しの下に出す補足。 */
  subtitle?: string;
  /** 内容の幅。表やリストを置くときは "lg"。 */
  size?: "sm" | "lg";
  onClose: () => void;
  /** 下部に固定するボタン列。 */
  footer: ComponentChildren;
  children: ComponentChildren;
};

/**
 * 画面の中央に出すダイアログ。
 * window.confirm / prompt は埋め込み WebView の権限設定で使えないことがあるため、自前で描く。
 * Escape で閉じ、Tab はダイアログの中だけで回す。内容が長いときは本文だけをスクロールさせる。
 */
export function Modal({ title, subtitle, size = "sm", onClose, footer, children }: ModalProps) {
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
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    // 背景の操作へ抜けないよう、Tab はダイアログの中だけで回す。
    const dialog = dialogRef.current;
    if (dialog === null) return;

    const elements = dialog.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = elements[0];
    const last = elements[elements.length - 1];
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
      <div class="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        class={`relative flex max-h-[85vh] w-full flex-col rounded-xl border border-neutral-200 bg-white shadow-xl outline-none dark:border-neutral-700 dark:bg-neutral-900 ${
          size === "lg" ? "max-w-lg" : "max-w-sm"
        }`}
      >
        <div class="shrink-0 px-5 pt-5">
          <h2 class="text-sm font-semibold">{title}</h2>
          {subtitle !== undefined && <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{subtitle}</p>}
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        <div class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
          {footer}
        </div>
      </div>
    </div>
  );
}

import { IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-preact";
import { useEffect, useRef } from "preact/hooks";
import type { SentAttachment } from "../../../shared/api/message";
import { t } from "../../i18n";
import { stepImageIndex } from "./lightbox";

/**
 * チャットの画像を画面の上に重ねて拡大する。
 * 別のタブは開かず、Escape または背景のクリックで閉じる。
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: readonly SentAttachment[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 開いた直後はダイアログ自体へフォーカスを移し、Escape と矢印キーをここで受ける。
    const previous = document.activeElement;
    dialogRef.current?.focus();

    // 閉じたら元の位置へ戻す。戻さないと、キーボード操作の続きが画面の先頭からになる。
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const image = images[index];
  if (image === undefined) return null;

  const multiple = images.length > 1;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (!multiple) return;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onIndexChange(stepImageIndex(index, images.length, -1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onIndexChange(stepImageIndex(index, images.length, 1));
    }
  };

  return (
    <div class="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-6">
      <div class="tera-fade-in absolute inset-0 bg-black/70 backdrop-blur-md" aria-hidden="true" onClick={onClose} />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.image.viewer")}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        class="relative flex max-h-full max-w-full flex-col items-center justify-center outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          title={t("chat.image.close")}
          aria-label={t("chat.image.close")}
          class="absolute top-0 right-0 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/95 text-black shadow-[var(--app-shadow-16)] transition hover:bg-white"
        >
          <IconX size={18} stroke={2} />
        </button>

        <img
          src={image.url}
          alt={image.name}
          width={image.image?.width}
          height={image.image?.height}
          class="max-h-[86dvh] max-w-full rounded-[16px] object-contain"
        />

        <p class="mt-2 max-w-full truncate text-xs text-white/80">{image.name}</p>
        {multiple && (
          <p class="mt-1 text-xs text-white/70 tera-tnum">
            {index + 1} / {images.length}
          </p>
        )}

        {multiple && (
          <>
            <button
              type="button"
              onClick={() => onIndexChange(stepImageIndex(index, images.length, -1))}
              title={t("chat.image.previous")}
              aria-label={t("chat.image.previous")}
              class="absolute top-1/2 left-0 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/95 text-black shadow-[var(--app-shadow-16)] transition hover:bg-white"
            >
              <IconChevronLeft size={20} stroke={2} />
            </button>
            <button
              type="button"
              onClick={() => onIndexChange(stepImageIndex(index, images.length, 1))}
              title={t("chat.image.next")}
              aria-label={t("chat.image.next")}
              class="absolute top-1/2 right-0 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/95 text-black shadow-[var(--app-shadow-16)] transition hover:bg-white"
            >
              <IconChevronRight size={20} stroke={2} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

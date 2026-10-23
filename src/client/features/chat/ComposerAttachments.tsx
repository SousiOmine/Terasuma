import { IconFile, IconX } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { formatBytes } from "../../../shared/text";
import { t } from "../../i18n";

/**
 * 入力欄に添付した画像やファイル。
 *
 * 画像は中身のプレビューを出し、それ以外は名前と大きさの札にする。
 * どちらも入力欄の枠の内側に並べるので、添付が増えると入力欄が縦に伸びる。
 */
export function ComposerAttachments({
  files,
  onRemove,
}: {
  files: readonly File[];
  onRemove: (index: number) => void;
}) {
  return (
    <div class="flex flex-wrap items-start gap-2 px-2.5 pb-1 pt-2.5">
      {files.map((file, index) => {
        const key = `${file.name}-${file.size}-${file.lastModified}-${index}`;
        return isImage(file) ? (
          <ImageAttachment key={key} file={file} onRemove={() => onRemove(index)} />
        ) : (
          <FileAttachment key={key} file={file} onRemove={() => onRemove(index)} />
        );
      })}
    </div>
  );
}

/** ブラウザがプレビューを描ける画像かどうか。 */
function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}

/** 画像のサムネイル。ファイルは画面の中にしか無いので、表示の間だけ object URL を作る。 */
function ImageAttachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useObjectUrl(file);
  const removeLabel = t("composer.attach.remove", { name: file.name });

  return (
    <div class="tera-pop-in w-20">
      <div class="relative h-20 w-20 overflow-hidden rounded-[14px] border border-stroke bg-soft">
        {url !== null && <img src={url} alt={file.name} title={file.name} class="h-full w-full object-cover" />}
        <button
          type="button"
          onClick={onRemove}
          title={removeLabel}
          aria-label={removeLabel}
          class="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full border border-stroke bg-surface text-secondary shadow-[var(--app-shadow-2)] transition hover:bg-soft hover:text-primary"
        >
          <IconX size={12} stroke={2.2} />
        </button>
      </div>
      <p class="mt-1 w-full truncate px-0.5 text-[10px] leading-4 text-tertiary" title={file.name}>
        {file.name}
      </p>
    </div>
  );
}

/** 画像以外のファイル。名前と大きさを 1 つの札にまとめる。 */
function FileAttachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const removeLabel = t("composer.attach.remove", { name: file.name });

  return (
    <span class="tera-pop-in inline-flex max-w-full items-center gap-1.5 rounded-full bg-soft py-1.5 pl-2.5 pr-1.5 text-xs">
      <IconFile size={14} stroke={1.9} class="shrink-0 text-secondary" />
      <span class="max-w-[220px] truncate" title={file.name}>
        {file.name}
      </span>
      <span class="shrink-0 text-secondary">{formatBytes(file.size)}</span>
      <button
        type="button"
        onClick={onRemove}
        title={removeLabel}
        aria-label={removeLabel}
        class="shrink-0 rounded-full p-0.5 text-secondary transition hover:bg-[var(--app-soft-strong)] hover:text-primary"
      >
        <IconX size={12} stroke={2} />
      </button>
    </span>
  );
}

/** 表示している間だけ有効な object URL を作り、外れたら解放する。 */
function useObjectUrl(file: File): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);

  return url;
}

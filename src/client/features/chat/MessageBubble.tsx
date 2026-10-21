import { IconDownload, IconFile } from "@tabler/icons-preact";
import { formatBytes } from "../../../shared/attachments";
import type { AttachmentPart, ChatMessage, NoticePart, SentAttachment, TextPart } from "../../../shared/types";
import { t } from "../../i18n";
import { ChatAvatar } from "./ChatAvatar";

/**
 * チャットの吹き出し。
 *
 * 画面に出すのは、ユーザーが書いた発言と、エージェントの本文・添付だけ。
 * ツールの記録は、ここへは渡さない。
 */

export function UserMessageBubble({ message, time }: { message: ChatMessage; time: string }) {
  const files = message.attachments ?? [];
  if (message.content.length === 0 && files.length === 0) return null;

  return (
    <div class="flex items-end justify-end gap-1.5">
      <time class="mb-1 shrink-0 text-[11px] text-[var(--app-text-tertiary)]">{time}</time>
      <div class="min-w-0 max-w-[calc(100%_-_2.75rem)] rounded-[24px] rounded-br-[8px] bg-[var(--app-ink-fill)] px-4 py-2.5 text-[15px] leading-6 text-[var(--app-on-ink)] shadow-[var(--app-shadow-2)]">
        {message.content.length > 0 && <div class="whitespace-pre-wrap break-words">{message.content}</div>}
        {files.length > 0 && (
          <div class={`flex flex-col gap-1.5 ${message.content.length > 0 ? "mt-2" : ""}`}>
            {files.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${index}`}
                class="flex w-64 max-w-full items-center gap-2 rounded-full bg-[var(--app-on-ink-soft)] px-3 py-1.5 text-xs"
              >
                <IconFile size={14} stroke={1.7} class="shrink-0 opacity-90" />
                <span class="min-w-0 flex-1 truncate">{file.name}</span>
                <span class="shrink-0 opacity-70">{formatBytes(file.size)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** エージェントの本文、または添付した写真・ファイル 1 件。 */
export function AgentMessageBubble({ part, time }: { part: TextPart | AttachmentPart; time: string }) {
  const images = part.type === "attachment" ? part.attachments.filter((attachment) => attachment.image !== null) : [];
  const files = part.type === "attachment" ? part.attachments.filter((attachment) => attachment.image === null) : [];

  return (
    <div class="flex items-end gap-1.5">
      <div class="min-w-0 max-w-[calc(100%_-_2.75rem)] rounded-[24px] rounded-bl-[8px] bg-[var(--app-surface-alt)] px-4 py-2.5 text-[15px] leading-6 text-[var(--app-text)]">
        <div class="flex flex-col gap-2">
          {part.type === "text" && <RichText content={part.text} />}
          {images.length > 0 && <ImageGrid images={images} />}
          {files.length > 0 && <FileList files={files} />}
        </div>
      </div>
      <time class="mb-1 shrink-0 text-[11px] text-[var(--app-text-tertiary)]">{time}</time>
    </div>
  );
}

/** 写真。1 枚なら大きく、複数なら 2 列に並べる。押すと元の大きさで開く。 */
function ImageGrid({ images }: { images: readonly SentAttachment[] }) {
  if (images.length === 1) {
    const image = images[0];
    if (image === undefined) return null;

    return (
      <a
        href={image.url}
        target="_blank"
        rel="noreferrer"
        title={t("chat.image.open", { name: image.name })}
        class="block overflow-hidden rounded-2xl"
      >
        <img
          src={image.url}
          alt={image.name}
          width={image.image?.width}
          height={image.image?.height}
          loading="lazy"
          class="max-h-72 w-auto max-w-full object-cover"
        />
      </a>
    );
  }

  return (
    <div class="grid w-[min(20rem,100%)] grid-cols-2 gap-1 overflow-hidden rounded-2xl">
      {images.map((image, index) => (
        <a
          key={`${image.url}-${index}`}
          href={image.url}
          target="_blank"
          rel="noreferrer"
          title={t("chat.image.open", { name: image.name })}
          class="block aspect-square overflow-hidden bg-[var(--app-soft)]"
        >
          <img src={image.url} alt={image.name} loading="lazy" class="h-full w-full object-cover" />
        </a>
      ))}
    </div>
  );
}

/** ダウンロードできるファイル。名前と大きさを出し、押すと保存する。 */
function FileList({ files }: { files: readonly SentAttachment[] }) {
  return (
    <div class="flex flex-col gap-1.5">
      {files.map((file, index) => (
        <a
          key={`${file.url}-${index}`}
          href={file.url}
          download
          title={t("chat.file.download", { name: file.name })}
          class="flex w-64 max-w-full items-center gap-2 rounded-2xl border border-[var(--app-stroke)] bg-[var(--app-surface)] px-3 py-2.5 transition hover:bg-[var(--app-soft)]"
        >
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--app-soft)] text-[var(--app-text)]">
            <IconFile size={16} stroke={1.7} />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs font-medium">{file.name}</span>
            <span class="block text-[11px] text-[var(--app-text-secondary)]">{formatBytes(file.size)}</span>
          </span>
          <IconDownload size={14} stroke={1.7} class="shrink-0 text-[var(--app-text-tertiary)]" />
        </a>
      ))}
    </div>
  );
}

/** システムの注記。発言ではないので、中央に小さく置く。 */
export function NoticeLine({ part }: { part: NoticePart }) {
  return (
    <div class="flex justify-center py-1">
      <p class="max-w-[85%] rounded-full bg-[var(--app-soft)] px-3.5 py-1.5 text-center text-[11px] leading-relaxed text-[var(--app-text-secondary)]">
        {part.text}
      </p>
    </div>
  );
}

/** エージェントが動いている間の印。本文は少しずつ出さないので、点だけを出す。 */
export function TypingBubble() {
  return (
    <div class="flex items-start gap-2" role="status" aria-label={t("chat.typing")}>
      <ChatAvatar size={30} />
      <div class="flex items-center gap-1.5 rounded-[24px] rounded-bl-[8px] bg-[var(--app-surface-alt)] px-4 py-3.5">
        <span class="tera-typing-dot h-1.5 w-1.5 rounded-full bg-[var(--app-text-tertiary)]" />
        <span class="tera-typing-dot h-1.5 w-1.5 rounded-full bg-[var(--app-text-tertiary)]" />
        <span class="tera-typing-dot h-1.5 w-1.5 rounded-full bg-[var(--app-text-tertiary)]" />
      </div>
    </div>
  );
}

/**
 * ``` で囲んだ範囲だけをコードブロックとして扱う最小限の整形。
 * Markdown 全体を解釈しないのは、依存を増やさず描画を軽く保つため。必要になったら差し替える。
 */
function RichText({ content }: { content: string }) {
  const segments = content.split("```");

  return (
    <div>
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <pre
            key={index}
            class="my-1 overflow-x-auto rounded-xl bg-[var(--app-soft)] p-3 text-xs leading-relaxed"
          >
            <code>{stripLanguageTag(segment)}</code>
          </pre>
        ) : (
          <span key={index} class="whitespace-pre-wrap break-words">
            {segment}
          </span>
        ),
      )}
    </div>
  );
}

/** ```ts のように書かれた言語名の行を取り除く。コード本体だけを表示するため。 */
function stripLanguageTag(block: string): string {
  const newline = block.indexOf("\n");
  if (newline === -1) return block;

  const firstLine = block.slice(0, newline).trim();
  return /^[A-Za-z0-9+#._-]*$/.test(firstLine) ? block.slice(newline + 1) : block;
}

import { IconDownload, IconFile } from "@tabler/icons-preact";
import { formatBytes } from "../../../shared/attachments";
import type { ChatMessage, NoticePart, SentAttachment, SentPart } from "../../../shared/types";
import { t } from "../../i18n";
import { ChatAvatar } from "./ChatAvatar";

/**
 * チャットの吹き出し。
 *
 * 画面に出すのは、ユーザーが書いた発言と、エージェントが chat_send で送ったメッセージだけ。
 * モデルの本文やツールの記録は、ここへは渡さない。
 */

export function UserMessageBubble({ message, time }: { message: ChatMessage; time: string }) {
  const files = message.attachments ?? [];
  if (message.content.length === 0 && files.length === 0) return null;

  return (
    <div class="flex items-end justify-end gap-1.5">
      <time class="mb-0.5 shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">{time}</time>
      <div class="min-w-0 max-w-[calc(100%_-_2.75rem)] rounded-2xl rounded-br-md bg-[#06c755] px-3.5 py-2.5 text-[15px] leading-relaxed text-white shadow-sm">
        {message.content.length > 0 && <div class="whitespace-pre-wrap break-words">{message.content}</div>}
        {files.length > 0 && (
          <div class={`flex flex-col gap-1.5 ${message.content.length > 0 ? "mt-2" : ""}`}>
            {files.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${index}`}
                class="flex w-64 max-w-full items-center gap-2 rounded-lg bg-white/15 px-2 py-1.5 text-xs"
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

/** エージェントが送ったメッセージ 1 件。写真とファイルは本文の下に並べる。 */
export function AgentMessageBubble({ part, time }: { part: SentPart; time: string }) {
  const images = part.attachments.filter((attachment) => attachment.image !== null);
  const files = part.attachments.filter((attachment) => attachment.image === null);

  return (
    <div class="flex items-end gap-1.5">
      <div class="min-w-0 max-w-[calc(100%_-_2.75rem)] rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-[15px] leading-relaxed text-neutral-900 shadow-sm ring-1 ring-black/5 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-white/5">
        <div class="flex flex-col gap-2">
          {images.length > 0 && <ImageGrid images={images} />}
          {part.text.length > 0 && <RichText content={part.text} />}
          {files.length > 0 && <FileList files={files} />}
        </div>
      </div>
      <time class="mb-0.5 shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">{time}</time>
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
        class="block overflow-hidden rounded-xl"
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
    <div class="grid w-[min(20rem,100%)] grid-cols-2 gap-1 overflow-hidden rounded-xl">
      {images.map((image, index) => (
        <a
          key={`${image.url}-${index}`}
          href={image.url}
          target="_blank"
          rel="noreferrer"
          title={t("chat.image.open", { name: image.name })}
          class="block aspect-square overflow-hidden bg-neutral-100 dark:bg-neutral-900"
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
          class="flex w-64 max-w-full items-center gap-2 rounded-xl border border-black/5 bg-neutral-50 px-2.5 py-2 transition hover:bg-neutral-100 dark:border-white/10 dark:bg-neutral-900/60 dark:hover:bg-neutral-800"
        >
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#06c755]/10 text-[#078f45] dark:bg-[#06c755]/15 dark:text-[#59d98a]">
            <IconFile size={16} stroke={1.7} />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs font-medium">{file.name}</span>
            <span class="block text-[10px] text-neutral-500 dark:text-neutral-400">{formatBytes(file.size)}</span>
          </span>
          <IconDownload size={14} stroke={1.7} class="shrink-0 text-neutral-400" />
        </a>
      ))}
    </div>
  );
}

/** システムの注記。発言ではないので、中央に小さく置く。 */
export function NoticeLine({ part }: { part: NoticePart }) {
  return (
    <div class="flex justify-center py-1">
      <p class="max-w-[85%] rounded-full bg-black/5 px-3 py-1 text-center text-[11px] leading-relaxed text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
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
      <div class="flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-white px-4 py-3.5 shadow-sm ring-1 ring-black/5 dark:bg-neutral-800 dark:ring-white/5">
        <span class="tera-typing-dot h-1.5 w-1.5 rounded-full bg-neutral-400" />
        <span class="tera-typing-dot h-1.5 w-1.5 rounded-full bg-neutral-400" />
        <span class="tera-typing-dot h-1.5 w-1.5 rounded-full bg-neutral-400" />
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
            class="my-1 overflow-x-auto rounded-lg bg-black/5 p-2.5 text-xs leading-relaxed dark:bg-black/30"
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

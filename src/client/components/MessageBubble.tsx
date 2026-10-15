import { IconTool } from "@tabler/icons-preact";
import type { ImageRef, MessagePart, MessageRole } from "../../shared/types";
import { t } from "../i18n";

export type MessageBubbleProps = {
  role: MessageRole;
  /** 本文。parts があるときは text 部分を連結したもの（表示には parts を使う）。 */
  content: string;
  /** ツールを使ったメッセージだけが持つ、本文とツールの並び。 */
  parts?: readonly MessagePart[] | null;
};

export function MessageBubble({ role, content, parts = null }: MessageBubbleProps) {
  if (role === "user") {
    return (
      <div class="flex justify-end">
        <div class="max-w-[85%] rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-white dark:bg-neutral-100 dark:text-neutral-900">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div class="flex justify-start">
      <div class="min-w-0 max-w-full flex-1 text-sm leading-relaxed">
        {parts === null || parts.length === 0 ? (
          <RichText content={content} />
        ) : (
          <div class="space-y-2">
            {parts.map((part, index) =>
              part.type === "text" ? (
                <RichText key={index} content={part.text} />
              ) : (
                <ToolBlock key={index} part={part} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** ツールの呼び出しと結果。モデルが何をしたかが分かる最小限の表示。 */
function ToolBlock({ part }: { part: MessagePart }) {
  if (part.type === "text") return null;

  return (
    <div class="rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div class="flex items-center gap-2 px-3 py-1.5 text-xs">
        <IconTool size={14} stroke={1.6} class="shrink-0 text-neutral-500 dark:text-neutral-400" />
        <span class="min-w-0 flex-1 truncate font-mono">
          {part.server.length === 0 ? part.tool : `${part.server}_${part.tool}`}
        </span>
        {part.type === "tool-result" && part.failed && (
          <span class="shrink-0 text-red-600 dark:text-red-400">{t("chat.tool.failed")}</span>
        )}
        {part.type === "tool-call" && (
          <span class="shrink-0 text-neutral-500 dark:text-neutral-400">{t("chat.tool.running")}</span>
        )}
      </div>

      {part.type === "tool-call" ? (
        <ToolText label={t("chat.tool.args")} text={formatArgs(part.args)} />
      ) : (
        <>
          <ToolText label={t("chat.tool.result")} text={part.output} />
          {part.image !== undefined && <ToolImage image={part.image} />}
        </>
      )}
    </div>
  );
}

/** ツールが撮った画像。会話に残して、あとから見返せるようにする。 */
function ToolImage({ image }: { image: ImageRef }) {
  return (
    <div class="border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
      <img
        src={`/api/images/${image.sha256}`}
        width={image.width}
        height={image.height}
        alt={t("chat.tool.screen")}
        loading="lazy"
        class="mt-0.5 h-auto w-full rounded-md border border-neutral-200 dark:border-neutral-800"
      />
    </div>
  );
}

function ToolText({ label, text }: { label: string; text: string }) {
  if (text.length === 0) return null;

  return (
    <div class="border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
      <p class="text-[11px] text-neutral-500 dark:text-neutral-400">{label}</p>
      <pre class="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

/** 引数は JSON として見せる。読めない場合はそのまま出す（原因を隠さない）。 */
function formatArgs(args: unknown): string {
  if (args === undefined) return "";
  if (typeof args === "string") return args;

  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
}

/**
 * ``` で囲んだ範囲だけをコードブロックとして扱う最小限の整形。
 * Markdown 全体を解釈しないのは、依存を増やさず描画を軽く保つため。必要になったら差し替える。
 */
function RichText({ content }: { content: string }) {
  const segments = content.split("```");

  return (
    <>
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <pre
            key={index}
            class="my-2 overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs leading-relaxed dark:bg-neutral-900"
          >
            <code>{stripLanguageTag(segment)}</code>
          </pre>
        ) : (
          <span key={index} class="whitespace-pre-wrap break-words">
            {segment}
          </span>
        ),
      )}
    </>
  );
}

/** ```ts のように書かれた言語名の行を取り除く。コード本体だけを表示するため。 */
function stripLanguageTag(block: string): string {
  const newline = block.indexOf("\n");
  if (newline === -1) return block;

  const firstLine = block.slice(0, newline).trim();
  return /^[A-Za-z0-9+#._-]*$/.test(firstLine) ? block.slice(newline + 1) : block;
}

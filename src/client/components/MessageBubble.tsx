import type { MessageRole } from "../../shared/types";

export function MessageBubble({ role, content }: { role: MessageRole; content: string }) {
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
      <div class="min-w-0 max-w-full text-sm leading-relaxed">
        <RichText content={content} />
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

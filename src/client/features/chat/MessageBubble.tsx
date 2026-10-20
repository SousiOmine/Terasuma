import type { MessageRole } from "../../../shared/types";
import { t } from "../../i18n";

export type MessageBubbleProps = {
  /** 発言者。user か assistant。 */
  author: MessageRole;
  /** 本文。ツールの呼び出しと結果は画面に出さないので、本文だけで足りる。 */
  content: string;
  /** 生成中かどうか。true の間は、本文の下に小さく「作業中…」を出す。 */
  working?: boolean;
};

export function MessageBubble({ author, content, working = false }: MessageBubbleProps) {
  if (author === "user") {
    return (
      <div class="flex justify-end">
        <div class="max-w-[85%] rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-white dark:bg-neutral-100 dark:text-neutral-900">
          {content}
        </div>
      </div>
    );
  }

  // 本文が無いターン（ツールだけを使った場合）は、何も出さない。
  // 空の枠を残すと、メッセージの間に理由の分からない余白ができる。
  if (content.length === 0 && !working) return null;

  return (
    <div class="flex justify-start">
      <div class="min-w-0 max-w-full flex-1 text-sm leading-relaxed">
        {content.length > 0 && <RichText content={content} />}
        {working && <Working hasText={content.length > 0} />}
      </div>
    </div>
  );
}

/**
 * エージェントが動いている間の印。
 * ツールの呼び出しと結果を 1 件ずつ出さない代わりに、動いていることだけを小さく出す。
 */
function Working({ hasText }: { hasText: boolean }) {
  return (
    <p class={`flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 ${hasText ? "mt-2" : ""}`}>
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 dark:bg-neutral-500" />
      {t("chat.working")}
    </p>
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

import { useEffect, useRef } from "preact/hooks";
import { t } from "../i18n";
import {
  activeSession,
  clearError,
  errorCode,
  errorDetail,
  isLoadingMessages,
  isStreaming,
  messages,
  streamingText,
} from "../state";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

export function ChatView() {
  const items = messages.value;
  const pending = streamingText.value;
  const streaming = isStreaming.value;
  const loading = isLoadingMessages.value;
  const error = errorCode.value;
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新しい内容が来たら末尾へ寄せる。会話が伸びる操作は送信とストリーミングだけなので十分。
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [items.length, pending, loading]);

  const title = activeSession.value?.title ?? t("sidebar.untitled");
  const showEmpty = !loading && items.length === 0 && pending.length === 0;

  return (
    <main class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-12 shrink-0 items-center border-b border-neutral-200 px-5 dark:border-neutral-800">
        <h1 class="truncate text-sm font-medium">{title}</h1>
      </header>

      <div ref={scrollRef} class="min-h-0 flex-1 overflow-y-auto">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8">
            {items.map((message) => (
              <MessageBubble key={message.id} role={message.role} content={message.content} />
            ))}
            {pending.length > 0 && <MessageBubble role="assistant" content={pending} />}
            {streaming && pending.length === 0 && <Replying />}
            {loading && <p class="text-sm text-neutral-500 dark:text-neutral-400">{t("chat.loading")}</p>}
          </div>
        )}
      </div>

      {error !== null && (
        <div class="px-5 pb-2">
          <div class="mx-auto flex w-full max-w-3xl items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
            <div class="min-w-0 flex-1">
              <p>{t(`error.${error}`)}</p>
              {errorDetail.value !== null && (
                <p class="mt-0.5 break-words text-xs opacity-70">{errorDetail.value}</p>
              )}
            </div>
            <button
              type="button"
              onClick={clearError}
              class="shrink-0 text-xs opacity-70 transition hover:opacity-100"
            >
              {t("error.dismiss")}
            </button>
          </div>
        </div>
      )}

      <Composer />
    </main>
  );
}

function EmptyState() {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <h2 class="text-lg font-medium">{t("chat.empty.title")}</h2>
      <p class="text-sm text-neutral-500 dark:text-neutral-400">{t("chat.empty.hint")}</p>
    </div>
  );
}

function Replying() {
  return <p class="text-sm text-neutral-500 dark:text-neutral-400">{t("chat.replying")}</p>;
}

import { useEffect, useRef } from "preact/hooks";
import { t } from "../i18n";
import { modelProblem } from "../modelSettings";
import {
  activeSession,
  clearError,
  errorCode,
  errorDetail,
  isLoadingMessages,
  isStreaming,
  messages,
  openSettings,
  streamingText,
} from "../state";
import { Composer } from "./Composer";
import { ErrorNotice } from "./ErrorNotice";
import { MessageBubble } from "./MessageBubble";

export function ChatView() {
  const items = messages.value;
  const pending = streamingText.value;
  const streaming = isStreaming.value;
  const loading = isLoadingMessages.value;
  const error = errorCode.value;
  const problem = modelProblem.value;
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

      {problem !== null && (
        <div class="shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2 dark:border-amber-900/60 dark:bg-amber-950/40">
          <div class="mx-auto flex w-full max-w-3xl items-center gap-3 text-sm text-amber-900 dark:text-amber-200">
            <p class="min-w-0 flex-1">
              {t(problem === "unset" ? "chat.model.unset" : "chat.model.providerMissing")}
            </p>
            <button
              type="button"
              onClick={() => openSettings("model")}
              class="shrink-0 rounded-lg border border-amber-300 px-2.5 py-1 text-xs transition hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/40"
            >
              {t("chat.model.openSettings")}
            </button>
          </div>
        </div>
      )}

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
          <div class="mx-auto w-full max-w-3xl">
            <ErrorNotice
              error={{ code: error, detail: errorDetail.value }}
              action={
                <div class="flex shrink-0 flex-col items-end gap-1">
                  {error === "model_not_configured" && (
                    <button type="button" onClick={() => openSettings("model")} class="text-xs underline">
                      {t("chat.model.openSettings")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={clearError}
                    class="text-xs opacity-70 transition hover:opacity-100"
                  >
                    {t("error.dismiss")}
                  </button>
                </div>
              }
            />
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

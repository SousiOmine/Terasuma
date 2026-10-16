import { IconLayoutSidebarRight } from "@tabler/icons-preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { containerStatus } from "../containerSettings";
import { t } from "../i18n";
import { modelProblem } from "../modelSettings";
import {
  activeTera,
  clearError,
  computerPaneOpen,
  errorCode,
  errorDetail,
  isLoadingMessages,
  isStreaming,
  messages,
  openSettings,
  streamingText,
  toggleComputerPane,
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
  // コンテナが使えないことは、呼んでから失敗させるのではなく、先に画面へ出しておく。
  const containerMissing = containerStatus.value?.state === "podman_missing";
  // 画面を開くボタンは、コンテナがある端末にだけ出す（押しても何も出ないボタンを作らない）。
  const containerAvailable = containerStatus.value !== null && !containerMissing;
  const paneOpen = computerPaneOpen.value;
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 末尾にいるかどうか。履歴を読んでいる間は引き戻さない。 */
  const stickToBottom = useRef(true);

  // 確定した会話は、増えたときだけ組み立て直す。
  // 生成中の本文が伸びるたびに全メッセージの部品を作り直すと、長い会話ほど重くなる。
  const bubbles = useMemo(
    () =>
      items.map((message) => (
        <MessageBubble key={message.id} role={message.role} content={message.content} />
      )),
    [items],
  );

  // 新しい内容が来たら末尾へ寄せる。会話が伸びる操作は送信とストリーミングだけなので十分。
  // 本文は少しずつ伸びるので、メッセージの数だけでは足りない（文字数も見る）。
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [items.length, pending.length, loading]);

  const handleScroll = (): void => {
    const node = scrollRef.current;
    if (node === null) return;

    // 最下部の近くにいるときだけ、これから来る内容に追従する。
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  };

  // 見出しは相手（Tera）の名前。いまは既定の 1 体しか居ないので、常に同じ名前になる。
  const title = activeTera.value?.name ?? "";
  const showEmpty = !loading && items.length === 0 && !streaming;

  return (
    <main class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 px-5 dark:border-neutral-800">
        <h1 class="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        {containerAvailable && (
          <button
            type="button"
            onClick={toggleComputerPane}
            aria-pressed={paneOpen}
            title={t(paneOpen ? "chat.computer.hide" : "chat.computer.show")}
            aria-label={t(paneOpen ? "chat.computer.hide" : "chat.computer.show")}
            class={`shrink-0 rounded-lg p-1.5 transition ${
              paneOpen
                ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                : "text-neutral-500 hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            <IconLayoutSidebarRight size={16} stroke={1.6} />
          </button>
        )}
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
              {t("chat.openSettings")}
            </button>
          </div>
        </div>
      )}

      {containerMissing && (
        <div class="shrink-0 border-b border-neutral-200 bg-neutral-100 px-5 py-2 dark:border-neutral-800 dark:bg-neutral-900">
          <div class="mx-auto flex w-full max-w-3xl items-center gap-3 text-sm text-neutral-700 dark:text-neutral-300">
            <p class="min-w-0 flex-1">{t("chat.container.unavailable")}</p>
            <button
              type="button"
              onClick={() => openSettings("container")}
              class="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1 text-xs transition hover:bg-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {t("chat.openSettings")}
            </button>
          </div>
        </div>
      )}

      <div ref={scrollRef} onScroll={handleScroll} class="min-h-0 flex-1 overflow-y-auto">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8">
            {bubbles}
            {streaming && <MessageBubble role="assistant" content={pending} working />}
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
                      {t("chat.openSettings")}
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
    <div class="flex h-full flex-col items-center justify-center px-6 text-center">
      <h2 class="text-lg font-medium">{t("chat.empty.title")}</h2>
    </div>
  );
}

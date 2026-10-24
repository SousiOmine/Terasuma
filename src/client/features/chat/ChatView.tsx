import { IconLayoutSidebarRight, IconMenu2 } from "@tabler/icons-preact";
import { useMemo } from "preact/hooks";
import { t } from "../../i18n";
import {
  isLoadingMessages,
  isLoadingOlderMessages,
  isStreaming,
  liveTurn,
  messages,
  retryLastTurn,
} from "../../state/chat";
import { connectorRequest } from "../../state/connector-request";
import { containerStatus } from "../../state/container";
import { envRequestActive } from "../../state/env-request";
import { chatError, clearChatError } from "../../state/failure";
import { isRetryableErrorCode } from "../../../shared/api/error";
import { computerPaneOpen, handoverActive, toggleComputerPane } from "../../state/handover";
import { modelProblem } from "../../state/model";
import { openSettings } from "../../state/route";
import { activeTera } from "../../state/session";
import { sidebarOpen, toggleSidebar } from "../../state/sidebar";
import { Banner } from "../../ui/Banner";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { ChatAvatar } from "./ChatAvatar";
import { Composer } from "./Composer";
import { ConnectorRequestPanel } from "./ConnectorRequestPanel";
import { EnvRequestPanel } from "./EnvRequestPanel";
import { AgentMessageBubble, NoticeLine, TypingBubble, UserMessageBubble } from "./MessageBubble";
import { buildItems, formatTime, localeTag, splitAroundLive, type ChatItem } from "./timeline";
import { UiCard } from "./UiCard";
import { useOlderPages } from "./useOlderPages";

/**
 * チャット画面。
 *
 * 会話の並びは timeline.ts、古いページの読み足しとスクロールは useOlderPages.ts が持つ。
 * ここは「何をどこに置くか」だけを書く。
 */

export function ChatView() {
  const tag = localeTag();
  // 保存済みの履歴を、伸びている応答の seq で前と後ろに分ける。
  // 応答中に届いた追加の発言（後ろ）は、応答より下に置く。
  // ターンが伸びても、保存済みの履歴を毎回組み直さない。
  const live = liveTurn.value;
  const split = useMemo(() => splitAroundLive(messages.value, live?.seq ?? null), [messages.value, live?.seq]);
  const head = useMemo(() => buildItems(split.before, null, tag), [split.before, tag]);
  const middle = useMemo(() => buildItems([], live, tag, head.lastDay), [live, head.lastDay, tag]);
  const tail = useMemo(
    () => buildItems(split.after, null, tag, middle.lastDay).items,
    [split.after, middle.lastDay, tag],
  );
  const items = useMemo(() => [...head.items, ...middle.items, ...tail], [head, middle, tail]);
  const streaming = isStreaming.value;
  const loading = isLoadingMessages.value;
  const error = chatError.value;
  const problem = modelProblem.value;
  // コンテナが使えないことは、呼んでから失敗させるのではなく、先に画面へ出しておく。
  const containerMissing = containerStatus.value?.state === "podman_missing";
  // 画面を開くボタンは、コンテナがある端末にだけ出す（押しても何も出ないボタンを作らない）。
  const containerAvailable = containerStatus.value !== null && !containerMissing;
  const paneOpen = computerPaneOpen.value;
  const handover = handoverActive.value;
  // 環境変数の入力待ち。引き受けとは別で、チャットの入力欄の上に入力欄を出す。
  const envWaiting = envRequestActive.value;
  // コネクタの設定待ち。同じく入力欄の上にカードを出す。
  const connectorWaiting = connectorRequest.value !== null;
  const { scrollRef, contentRef, handleScroll } = useOlderPages({ items, streaming });

  // 見出しは相手（Tera）の名前。いまは既定の 1 体しか居ないので、常に同じ名前になる。
  const title = activeTera.value?.name ?? "";
  const showEmpty = !loading && items.length === 0 && !streaming;

  return (
    <main class="flex min-w-0 flex-1 flex-col bg-surface md:m-3 md:overflow-hidden md:rounded-[30px] md:border md:border-stroke md:shadow-[var(--app-shadow-panel)]">
      <header class="flex h-16 shrink-0 items-center gap-3 px-4 sm:px-5">
        {/* 狭い画面ではサイドバーがドロワーになるので、開くボタンをここに置く。 */}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-expanded={sidebarOpen.value}
          title={t("chat.menu.open")}
          aria-label={t("chat.menu.open")}
          class="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-secondary transition hover:bg-soft hover:text-primary md:hidden"
        >
          <IconMenu2 size={20} stroke={1.7} />
        </button>
        <ChatAvatar size={32} />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">{title}</h1>
          <p class="truncate text-[11px] leading-4 text-secondary">
            {handover
              ? t("chat.computer.yourTurn")
              : connectorWaiting
                ? t("chat.connector.waitingShort")
                : envWaiting
                  ? t("chat.env.waiting")
                  : streaming
                    ? t("chat.typing")
                    : t("chat.agent.subtitle")}
          </p>
        </div>
        {containerAvailable && (
          <button
            type="button"
            onClick={toggleComputerPane}
            aria-pressed={paneOpen}
            title={t(paneOpen ? "chat.computer.hide" : "chat.computer.show")}
            aria-label={t(paneOpen ? "chat.computer.hide" : "chat.computer.show")}
            class={`flex shrink-0 items-center justify-center rounded-full p-2.5 transition md:p-2 ${
              paneOpen ? "bg-soft text-primary" : "text-secondary hover:bg-soft hover:text-primary"
            }`}
          >
            <IconLayoutSidebarRight size={17} stroke={1.7} />
          </button>
        )}
      </header>

      {problem !== null && (
        <Banner tone="info" action={{ label: t("chat.openSettings"), onClick: () => openSettings("model") }}>
          {t(problem === "unset" ? "chat.model.unset" : "chat.model.providerMissing")}
        </Banner>
      )}

      {containerMissing && (
        <Banner tone="muted" action={{ label: t("chat.openSettings"), onClick: () => openSettings("container") }}>
          {t("chat.container.unavailable")}
        </Banner>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        class="min-h-0 flex-1 overflow-y-auto bg-surface [overflow-anchor:none]"
      >
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div ref={contentRef} class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
            {isLoadingOlderMessages.value && (
              <p class="text-center text-[11px] text-tertiary">{t("chat.history.loadingOlder")}</p>
            )}
            {items.map((item) => renderItem(item))}
            {streaming && !handover && !envWaiting && <TypingBubble />}
            {loading && <p class="text-center text-sm text-secondary">{t("common.loading")}</p>}
          </div>
        )}
      </div>

      {error !== null && (
        <div class="px-4 pb-2 sm:px-6">
          <div class="mx-auto w-full max-w-3xl">
            <ErrorNotice
              error={error}
              action={
                <div class="flex shrink-0 flex-col items-end gap-1">
                  {error.code === "model_not_configured" && (
                    <button
                      type="button"
                      onClick={() => openSettings("model")}
                      class="text-xs font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {t("chat.openSettings")}
                    </button>
                  )}
                  {isRetryableErrorCode(error.code) && (
                    <button
                      type="button"
                      onClick={() => {
                        clearChatError();
                        void retryLastTurn();
                      }}
                      class="text-xs font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {t("chat.retry")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={clearChatError}
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

      {/* コネクタの設定も、ふだんの入力欄のすぐ上に出す（送る先がチャットとは違うため別の面にする）。 */}
      {connectorWaiting && (
        <div class="shrink-0 px-3 pt-2 sm:px-6">
          <div class="mx-auto w-full max-w-3xl">
            <ConnectorRequestPanel />
          </div>
        </div>
      )}

      {/* 環境変数の入力は、ふだんの入力欄のすぐ上に出す（送る先がチャットとは違うため別の面にする）。 */}
      {envWaiting && (
        <div class="shrink-0 px-3 pt-2 sm:px-6">
          <div class="mx-auto w-full max-w-3xl">
            <EnvRequestPanel />
          </div>
        </div>
      )}

      <Composer />
    </main>
  );
}

function renderItem(item: ChatItem) {
  const tag = localeTag();

  switch (item.kind) {
    case "date":
      return (
        <div key={item.key} class="tera-fade-in flex justify-center py-1.5">
          <span class="text-[11px] font-medium tracking-[0.06em] text-tertiary">{item.label}</span>
        </div>
      );
    case "user":
      return <UserMessageBubble key={item.key} message={item.message} time={formatTime(item.message.createdAt, tag)} />;
    case "agent": {
      const last = item.parts[item.parts.length - 1];
      return (
        <div key={item.key} class="flex items-start gap-3">
          <ChatAvatar size={24} class="mt-0.5" />
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="flex min-w-0 flex-col gap-2">
              {item.parts.map((part, index) => (
                <AgentMessageBubble key={`${item.key}-${index}`} part={part} />
              ))}
            </div>
            {last !== undefined && <time class="text-[11px] text-tertiary tera-tnum">{formatTime(last.at, tag)}</time>}
          </div>
        </div>
      );
    }
    case "ui":
      return (
        <div key={item.key} class="flex items-start gap-3">
          <ChatAvatar size={24} class="mt-0.5" />
          <div class="min-w-0 flex-1">
            <UiCard view={item.view} />
          </div>
        </div>
      );
    case "notice":
      return <NoticeLine key={item.key} part={item.part} />;
  }
}

function EmptyState() {
  return (
    <div class="tera-rise flex h-full flex-col items-center justify-center gap-5 px-6 pb-6 text-center">
      <ChatAvatar size={64} />
      <div class="max-w-sm">
        <h2 class="tera-balance text-[22px] leading-8 font-semibold tracking-[-0.02em]">{t("chat.empty.title")}</h2>
        <p class="mt-2 text-[13px] leading-6 text-secondary">{t("chat.empty.description")}</p>
      </div>
    </div>
  );
}

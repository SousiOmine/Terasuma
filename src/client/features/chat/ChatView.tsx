import { IconLayoutSidebarRight, IconMenu2 } from "@tabler/icons-preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import type { AttachmentPart, ChatMessage, MessagePart, NoticePart, TextPart } from "../../../shared/types";
import { containerStatus } from "../../state/container";
import { locale, t } from "../../i18n";
import { modelProblem } from "../../state/model";
import { isLoadingMessages, isStreaming, liveTurn, messages, type LiveTurn } from "../../state/chat";
import { chatError, clearChatError } from "../../state/failure";
import { connectionRequest } from "../../state/connection-request";
import { envRequestActive } from "../../state/env-request";
import { computerPaneOpen, handoverActive, toggleComputerPane } from "../../state/handover";
import { openSettings } from "../../state/route";
import { activeTera } from "../../state/session";
import { sidebarOpen, toggleSidebar } from "../../state/sidebar";
import { Banner } from "../../ui/Banner";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { ChatAvatar } from "./ChatAvatar";
import { Composer } from "./Composer";
import { ConnectionRequestPanel } from "./ConnectionRequestPanel";
import { EnvRequestPanel } from "./EnvRequestPanel";
import { AgentMessageBubble, NoticeLine, TypingBubble, UserMessageBubble } from "./MessageBubble";

/**
 * チャット画面。
 *
 * 会話は、ユーザーの発言と、エージェントの本文・添付だけで組み立てる。
 * 本文は区切りごとに届くので、少しずつ伸びる表示は無い（メッセージは届いた単位で出る）。
 */

/** 画面に出す、本文と添付。注記は別に扱う。 */
type VisibleMessagePart = TextPart | AttachmentPart;

type ChatItem =
  | { kind: "date"; key: string; label: string }
  | { kind: "user"; key: string; message: ChatMessage }
  | { kind: "agent"; key: string; parts: readonly VisibleMessagePart[] }
  | { kind: "notice"; key: string; part: NoticePart };

export function ChatView() {
  const items = useMemo(
    () => buildItems(messages.value, liveTurn.value, localeTag()),
    // locale を変えると日付の書き方も変わる。
    [messages.value, liveTurn.value, locale.value],
  );
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
  // アプリの認証待ち。同じく入力欄の上にカードを出す。
  const connectionWaiting = connectionRequest.value !== null;
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 末尾にいるかどうか。履歴を読んでいる間は引き戻さない。 */
  const stickToBottom = useRef(true);

  // 新しい内容が来たら末尾へ寄せる。メッセージは届いた単位で増えるので、数を見れば足りる。
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [items.length, streaming]);

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
    <main class="flex min-w-0 flex-1 flex-col bg-[var(--app-surface)] md:m-3 md:overflow-hidden md:rounded-[30px] md:border md:border-[var(--app-stroke)] md:shadow-[var(--app-shadow-panel)]">
      <header class="flex h-16 shrink-0 items-center gap-3 px-4 sm:px-5">
        {/* 狭い画面ではサイドバーがドロワーになるので、開くボタンをここに置く。 */}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-expanded={sidebarOpen.value}
          title={t("chat.menu.open")}
          aria-label={t("chat.menu.open")}
          class="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-text-secondary)] transition hover:bg-[var(--app-soft)] hover:text-[var(--app-text)] md:hidden"
        >
          <IconMenu2 size={20} stroke={1.7} />
        </button>
        <ChatAvatar size={32} />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">{title}</h1>
          <p class="truncate text-[11px] leading-4 text-[var(--app-text-secondary)]">
            {handover
              ? t("chat.computer.yourTurn")
              : connectionWaiting
                ? t("chat.connection.waitingShort")
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
              paneOpen
                ? "bg-[var(--app-soft)] text-[var(--app-text)]"
                : "text-[var(--app-text-secondary)] hover:bg-[var(--app-soft)] hover:text-[var(--app-text)]"
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

      <div ref={scrollRef} onScroll={handleScroll} class="min-h-0 flex-1 overflow-y-auto bg-[var(--app-surface)]">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
            {items.map((item) => renderItem(item))}
            {streaming && !handover && !envWaiting && <TypingBubble />}
            {loading && <p class="text-center text-sm text-[var(--app-text-secondary)]">{t("common.loading")}</p>}
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
                      class="text-xs font-medium text-[var(--app-text)] underline-offset-2 hover:underline"
                    >
                      {t("chat.openSettings")}
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

      {/* アプリの認証も、ふだんの入力欄のすぐ上に出す（送る先がチャットとは違うため別の面にする）。 */}
      {connectionWaiting && (
        <div class="shrink-0 px-3 pt-2 sm:px-6">
          <div class="mx-auto w-full max-w-3xl">
            <ConnectionRequestPanel />
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
        <div key={item.key} class="flex justify-center py-1.5">
          <span class="text-[11px] font-medium tracking-[0.06em] text-[var(--app-text-tertiary)]">{item.label}</span>
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
            {last !== undefined && (
              <time class="text-[11px] text-[var(--app-text-tertiary)] tera-tnum">{formatTime(last.at, tag)}</time>
            )}
          </div>
        </div>
      );
    }
    case "notice":
      return <NoticeLine key={item.key} part={item.part} />;
  }
}

/**
 * 保存された会話と、届いている途中のターンを、画面の並びへ開く。
 *
 * assistant のメッセージは parts の text・attachment・notice を出す。
 * 連続する text と attachment は、同じターンの 1 つのまとまりにし、アイコンと時刻は 1 つだけ出す。
 */
function buildItems(saved: readonly ChatMessage[], live: LiveTurn | null, tag: string): ChatItem[] {
  const items: ChatItem[] = [];
  let currentDay: string | null = null;

  const pushDate = (at: number): void => {
    const day = dayKey(at);
    if (day === currentDay) return;

    currentDay = day;
    items.push({ kind: "date", key: `date-${day}-${items.length}`, label: formatDate(at, tag) });
  };

  for (const message of saved) {
    if (message.role === "user") {
      pushDate(message.createdAt);
      items.push({ kind: "user", key: message.id, message });
      continue;
    }

    if (message.parts !== null) pushParts(items, message.id, visibleParts(message.parts), pushDate);
  }

  if (live !== null) pushParts(items, live.id, live.parts, pushDate);

  return items;
}

/** 記録のうち、画面に出す部分だけを取り出す。 */
function visibleParts(parts: readonly MessagePart[]): (VisibleMessagePart | NoticePart)[] {
  return parts.filter(
    (part): part is VisibleMessagePart | NoticePart =>
      (part.type === "text" && part.text.length > 0) || part.type === "attachment" || part.type === "notice",
  );
}

/** 1 つのターンの parts を、本文のまとまりと注記の並びにする。 */
function pushParts(
  items: ChatItem[],
  messageId: string,
  parts: readonly (VisibleMessagePart | NoticePart)[],
  pushDate: (at: number) => void,
): void {
  let group: VisibleMessagePart[] = [];
  let groupIndex = 0;
  let groupDay: string | null = null;
  let noticeIndex = 0;

  const flush = (): void => {
    if (group.length === 0) return;

    items.push({ kind: "agent", key: `${messageId}-group-${groupIndex}`, parts: group });
    group = [];
    groupIndex += 1;
    groupDay = null;
  };

  for (const part of parts) {
    const day = dayKey(part.at);
    // 日付をまたいだら、別のまとまりにする（日付の区切りが群の中に入らないように）。
    if (group.length > 0 && day !== groupDay) flush();

    pushDate(part.at);

    if (part.type !== "notice") {
      group.push(part);
      groupDay = day;
      continue;
    }

    flush();
    items.push({ kind: "notice", key: `${messageId}-notice-${noticeIndex}`, part });
    noticeIndex += 1;
  }

  flush();
}

function localeTag(): string {
  return locale.value === "ja" ? "ja-JP" : "en-US";
}

/** 日付が変わったかどうかを見るための、その端末の暦での日付。 */
function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function formatDate(at: number, tag: string): string {
  return new Intl.DateTimeFormat(tag, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(at);
}

function formatTime(at: number, tag: string): string {
  return new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }).format(at);
}

function EmptyState() {
  return (
    <div class="tera-rise flex h-full flex-col items-center justify-center gap-5 px-6 pb-6 text-center">
      <ChatAvatar size={64} />
      <div class="max-w-sm">
        <h2 class="tera-balance text-[22px] leading-8 font-semibold tracking-[-0.02em]">{t("chat.empty.title")}</h2>
        <p class="mt-2 text-[13px] leading-6 text-[var(--app-text-secondary)]">{t("chat.empty.description")}</p>
      </div>
    </div>
  );
}

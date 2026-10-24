import { isDisplayPart } from "../../../shared/display-parts";
import type { AttachmentPart, ChatMessageView, MessagePart, NoticePart, TextPart } from "../../../shared/api/message";
import type { UiView } from "../../../shared/ui-markup";
import { locale } from "../../i18n";
import { chatUiPartOf } from "../../lib/ui";
import type { LiveTurn } from "../../state/chat";

/**
 * チャットの並びを組み立てる。
 *
 * 保存済みの履歴と、届いている途中のターンを、画面に出す並びへ開く。
 * DOM を使わないので、日付の区切りやカードの位置をテストで確かめられる。
 */

/** 本文と添付のまとまり。 */
export type GroupPart = TextPart | AttachmentPart;

/** 画面に出す、UI のカード 1 枚。 */
export type UiDisplayPart = { type: "ui"; callId: string; view: UiView | null; at: number };

/** 画面に出す部品。注記は別に扱う。 */
export type DisplayPart = GroupPart | UiDisplayPart | NoticePart;

export type ChatItem =
  | { kind: "date"; key: string; label: string }
  | { kind: "user"; key: string; message: ChatMessageView }
  | { kind: "agent"; key: string; parts: readonly GroupPart[] }
  | { kind: "ui"; key: string; view: UiView | null }
  | { kind: "notice"; key: string; part: NoticePart };

/**
 * 保存済みの履歴を、伸びている応答（liveTurn）の seq で前後に分ける。
 * 応答の行は生成の開始時に予約されるので、その seq より後ろの保存済み発言
 * （応答中に届いた追加の発言）は、応答より下に置く。
 * 応答そのものの行（seq が同じ）は、どちらにも入れない（liveTurn が描く）。
 */
export function splitAroundLive(
  messages: readonly ChatMessageView[],
  liveSeq: number | null,
): { before: ChatMessageView[]; after: ChatMessageView[] } {
  if (liveSeq === null) return { before: [...messages], after: [] };
  return {
    before: messages.filter((message) => message.seq < liveSeq),
    after: messages.filter((message) => message.seq > liveSeq),
  };
}

/**
 * 保存された会話と、届いている途中のターンを、画面の並びへ開く。
 *
 * assistant のメッセージは parts の text・attachment・notice と、chat_ui のカードを出す。
 * 連続する text と attachment は、同じターンの 1 つのまとまりにし、アイコンと時刻は 1 つだけ出す。
 * 保存済みと受信中を分けて組み立てるときは、startDay に前の並びの最後の日を渡す。
 */
export function buildItems(
  saved: readonly ChatMessageView[],
  live: LiveTurn | null,
  tag: string,
  startDay: string | null = null,
): { items: ChatItem[]; lastDay: string | null } {
  const items: ChatItem[] = [];
  let currentDay: string | null = startDay;

  const pushDate = (at: number): void => {
    const day = dayKey(at);
    if (day === currentDay) return;

    currentDay = day;
    items.push({ kind: "date", key: `date-${day}`, label: formatDate(at, tag) });
  };

  for (const message of saved) {
    if (message.role === "user") {
      pushDate(message.createdAt);
      items.push({ kind: "user", key: message.id, message });
      continue;
    }

    if (message.parts !== null) pushParts(items, message.id, displayParts(message.parts, message.createdAt), pushDate);
  }

  if (live !== null) pushParts(items, live.id, displayParts(live.parts, live.createdAt), pushDate);

  return { items, lastDay: currentDay };
}

/**
 * 記録のうち、画面に出す部分だけを取り出す。
 * chat_ui の呼び出しは、引数のマークアップからカードを作る。

/**
 * 記録のうち、画面に出す部分だけを取り出す。
 * chat_ui の呼び出しは、引数のマークアップからカードを作る。
 */
function displayParts(parts: readonly MessagePart[], at: number): DisplayPart[] {
  const display: DisplayPart[] = [];

  for (const part of parts) {
    if (!isDisplayPart(part)) continue;

    switch (part.type) {
      case "text":
        if (part.text.length > 0) display.push(part);
        break;
      case "attachment":
      case "notice":
        display.push(part);
        break;
      case "tool-call": {
        const ui = chatUiPartOf(part);
        if (ui !== null) display.push({ type: "ui", callId: ui.callId, view: ui.view, at });
        break;
      }
      case "tool-result":
        break;
    }
  }

  return display;
}

/** 1 つのターンの parts を、本文のまとまり・カード・注記の並びにする。 */
function pushParts(
  items: ChatItem[],
  messageId: string,
  parts: readonly DisplayPart[],
  pushDate: (at: number) => void,
): void {
  let group: GroupPart[] = [];
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

    if (part.type === "ui") {
      flush();
      items.push({ kind: "ui", key: `${messageId}-ui-${part.callId}`, view: part.view });
      continue;
    }

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

export function localeTag(): string {
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

export function formatTime(at: number, tag: string): string {
  return new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }).format(at);
}

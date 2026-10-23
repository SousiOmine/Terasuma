import { describe, expect, test } from "bun:test";
import { CHAT_SERVER_ID, UI_TOOL } from "../../src/shared/tools";
import type { ChatMessage, MessagePart } from "../../src/shared/api/message";
import { buildItems } from "../../src/client/features/chat/timeline";
import type { LiveTurn } from "../../src/client/state/chat";

const TAG = "ja-JP";
const DAY1 = new Date(2026, 0, 2, 10, 0).getTime();
const DAY2 = new Date(2026, 0, 3, 10, 0).getTime();

function assistant(id: string, parts: MessagePart[], at: number): ChatMessage {
  return {
    id,
    teraId: "t",
    seq: 1,
    role: "assistant",
    content: "",
    attachments: null,
    parts,
    createdAt: at,
    usage: null,
  };
}

function user(id: string, text: string, at: number): ChatMessage {
  return {
    id,
    teraId: "t",
    seq: 0,
    role: "user",
    content: text,
    attachments: null,
    parts: null,
    createdAt: at,
    usage: null,
  };
}

const uiCall = (id: string): MessagePart => ({
  type: "tool-call",
  id,
  server: CHAT_SERVER_ID,
  tool: UI_TOOL,
  args: { markup: '<Card title="確認"><Text>進めますか</Text></Card>' },
});

describe("チャットの並び", () => {
  test("日付の区切りを先頭に置き、ユーザーの発言はそのまま並べる", () => {
    const items = buildItems([user("u1", "こんにちは", DAY1)], null, TAG).items;

    // 1 月 2 日は金曜日。
    expect(items[0]).toMatchObject({ kind: "date", label: "2026年1月2日(金)" });
    expect(items[1]).toMatchObject({ kind: "user", message: { id: "u1" } });
  });

  test("連続する本文と添付は 1 つのまとまりにし、注記で区切る", () => {
    const attachment: MessagePart = {
      type: "attachment",
      at: DAY1,
      attachments: [{ name: "a.txt", size: 3, url: "/api/files/x", image: null }],
    };
    const items = buildItems(
      [
        assistant(
          "a1",
          [
            { type: "text", text: "前半", at: DAY1 },
            attachment,
            { type: "text", text: "後半", at: DAY1 },
            { type: "notice", text: "上限に達しました", at: DAY1 },
          ],
          DAY1,
        ),
      ],
      null,
      TAG,
    ).items;

    expect(items.map((item) => item.kind)).toEqual(["date", "agent", "notice"]);
    const agent = items[1];
    expect(agent?.kind === "agent" ? agent.parts.length : 0).toBe(3);
  });

  test("chat_ui の呼び出しはカードになる", () => {
    const items = buildItems([assistant("a1", [uiCall("c1")], DAY1)], null, TAG).items;

    expect(items.map((item) => item.kind)).toEqual(["date", "ui"]);
  });

  test("受信中のターンは、保存済みの最後の日付を引き継ぐ", () => {
    const saved = buildItems([user("u1", "きのう", DAY1)], null, TAG);
    const live: LiveTurn = {
      id: "live",
      createdAt: DAY2,
      parts: [{ type: "text", text: "きょう", at: DAY2 }],
    };
    const continued = buildItems([], live, TAG, saved.lastDay).items;

    expect(continued.map((item) => item.kind)).toEqual(["date", "agent"]);
    expect(continued[0]?.kind === "date" ? continued[0].label : "").toContain("1月3日");
  });
});

import { describe, expect, test } from "bun:test";
import { toMessageView } from "../src/server/agent/message-view";
import type { ChatMessage, MessagePart, SentAttachment } from "../src/shared/types";

const attachment: SentAttachment = {
  name: "notes.txt",
  size: 5,
  url: "/api/files/abc",
  image: null,
};

function message(parts: MessagePart[]): ChatMessage {
  return {
    id: "m1",
    teraId: "default",
    seq: 1,
    role: "assistant",
    content: "",
    attachments: null,
    parts,
    createdAt: 1,
    usage: null,
  };
}

const text: MessagePart = { type: "text", text: "本文", at: 1 };
const notice: MessagePart = { type: "notice", text: "注記", at: 2 };
const attachmentPart: MessagePart = { type: "attachment", attachments: [attachment], at: 3 };
const uiCall: MessagePart = { type: "tool-call", id: "ui", server: "chat", tool: "ui", args: { markup: "<Card />" } };
const otherCall: MessagePart = { type: "tool-call", id: "shell", server: "", tool: "bash", args: { command: "ls" } };
const result: MessagePart = {
  type: "tool-result",
  id: "shell",
  server: "",
  tool: "bash",
  failed: false,
  output: "out",
};

describe("toMessageView", () => {
  test("本文・添付・注記・chat_ui の呼び出しだけを残す", () => {
    const view = toMessageView(message([text, uiCall, otherCall, result, notice, attachmentPart]));
    expect(view.parts).toEqual([text, uiCall, notice, attachmentPart]);
  });

  test("落とす部分が無ければ、同じメッセージを返す", () => {
    const original = message([text, uiCall]);
    expect(toMessageView(original)).toBe(original);
  });

  test("保存した記録と配列を書き換えない", () => {
    const parts = [text, otherCall, result, notice];
    const original = message(parts);
    const view = toMessageView(original);

    expect(parts.map((part) => part.type)).toEqual(["text", "tool-call", "tool-result", "notice"]);
    expect(original.parts).toHaveLength(4);
    expect(view.parts?.map((part) => part.type)).toEqual(["text", "notice"]);
  });

  test("parts が null のメッセージはそのまま返す", () => {
    const user: ChatMessage = {
      id: "u1",
      teraId: "default",
      seq: 1,
      role: "user",
      content: "こんにちは",
      attachments: null,
      parts: null,
      createdAt: 1,
      usage: null,
    };

    expect(toMessageView(user)).toBe(user);
  });
});

import { describe, expect, test } from "bun:test";
import { attachmentNotice, userContentForModel, withAttachmentNotice } from "../src/server/agent/model-content";
import type { ChatAttachment, ChatMessage } from "../src/shared/types";

function message(content: string, attachments: ChatAttachment[] | null): ChatMessage {
  return {
    id: "m1",
    teraId: "t1",
    seq: 1,
    role: "user",
    content,
    attachments,
    parts: null,
    createdAt: 1,
    usage: null,
  };
}

const attachment: ChatAttachment = {
  name: "notes.txt",
  size: 5,
  path: "/home/agent/uploads/abc/01-notes.txt",
};

describe("モデルへ渡すユーザー本文", () => {
  test("添付が無ければ、画面の本文をそのまま渡す", () => {
    expect(userContentForModel(message("見てください", null))).toBe("見てください");
    expect(userContentForModel(message("見てください", []))).toBe("見てください");
  });

  test("添付があれば、画面の本文に英語の案内を足す", () => {
    const content = userContentForModel(message("見てください", [attachment]));

    expect(content.startsWith("見てください\n\n[Attached files]\n")).toBe(true);
    expect(content).toContain("notes.txt: /home/agent/uploads/abc/01-notes.txt (5 B)");
    expect(content).toContain("Open them with the read or bash tools.");
  });

  test("本文が空なら、案内だけを渡す", () => {
    expect(withAttachmentNotice("", [attachment])).toBe(attachmentNotice([attachment]));
  });

  test("添付が無ければ、案内を作らない", () => {
    expect(attachmentNotice([])).toBe("");
  });
});

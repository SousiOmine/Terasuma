import { describe, expect, test } from "bun:test";
import type { GroupPart } from "../../src/client/features/chat/timeline";
import { messageTextOf } from "../../src/client/features/chat/copy-text";

const attachment: GroupPart = {
  type: "attachment",
  at: 2,
  attachments: [{ name: "a.txt", size: 3, url: "/api/files/a", image: null }],
};

describe("コピーする本文", () => {
  test("本文だけを空行でつなぐ", () => {
    const parts: GroupPart[] = [
      { type: "text", text: "前半", at: 1 },
      { type: "text", text: "後半", at: 3 },
    ];

    expect(messageTextOf(parts)).toBe("前半\n\n後半");
  });

  test("添付は無視する", () => {
    const parts: GroupPart[] = [
      { type: "text", text: "本文", at: 1 },
      attachment,
      { type: "text", text: "続き", at: 3 },
    ];

    expect(messageTextOf(parts)).toBe("本文\n\n続き");
  });

  test("空文字の本文は飛ばし、何も無ければ空文字", () => {
    expect(
      messageTextOf([
        { type: "text", text: "  ", at: 1 },
        { type: "text", text: "", at: 2 },
      ]),
    ).toBe("");
    expect(messageTextOf([attachment])).toBe("");
    expect(messageTextOf([])).toBe("");
  });

  test("前後の空白は落とす", () => {
    expect(
      messageTextOf([
        { type: "text", text: "\n  前  ", at: 1 },
        { type: "text", text: "  後  \n", at: 2 },
      ]),
    ).toBe("前\n\n後");
  });
});

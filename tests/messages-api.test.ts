import { describe, expect, test } from "bun:test";
import { DEFAULT_TERA_ID, type Store } from "../src/server/data/store";
import type { MessagePage, MessagePart, NoticePart, TextPart } from "../src/shared/api/message";
import { type ServerHarness, withServer } from "./harness";

const TERA = DEFAULT_TERA_ID;

/** 本文が 1, 2, ... の user メッセージを、指定した数だけ積む。 */
function seed(store: Store, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    store.appendMessage({ id: `m${index}`, teraId: TERA, role: "user", content: String(index) });
  }
}

async function pageAt(harness: ServerHarness, query: string): Promise<MessagePage> {
  const response = await harness.request(`/api/teras/${TERA}/messages${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as MessagePage;
}

describe("GET /api/teras/:id/messages", () => {
  test("最新のページを古い順で返し、古い側の有無を返す", async () => {
    await withServer(async (harness) => {
      seed(harness.store, 5);

      const page = await pageAt(harness, "?limit=2");
      expect(page.messages.map((message) => message.content)).toEqual(["4", "5"]);
      expect(page.hasMore).toBe(true);
    });
  });

  test("before で、その seq より前のページを続けて読める", async () => {
    await withServer(async (harness) => {
      seed(harness.store, 5);

      const page = await pageAt(harness, "?limit=2&before=4");
      expect(page.messages.map((message) => message.content)).toEqual(["2", "3"]);
      expect(page.hasMore).toBe(true);

      const oldest = await pageAt(harness, "?limit=2&before=2");
      expect(oldest.messages.map((message) => message.content)).toEqual(["1"]);
      expect(oldest.hasMore).toBe(false);
    });
  });

  test("limit が無い・整数でない・範囲外なら 400", async () => {
    await withServer(async (harness) => {
      for (const query of ["", "?limit=", "?limit=abc", "?limit=0", "?limit=101", "?limit=1.5"]) {
        const response = await harness.request(`/api/teras/${TERA}/messages${query}`);
        expect(response.status, query).toBe(400);
        expect(((await response.json()) as { code: string }).code, query).toBe("invalid_request");
      }
    });
  });

  test("before が整数でなければ 400", async () => {
    await withServer(async (harness) => {
      for (const query of ["?limit=2&before=abc", "?limit=2&before=0", "?limit=2&before=-1"]) {
        const response = await harness.request(`/api/teras/${TERA}/messages${query}`);
        expect(response.status, query).toBe(400);
      }
    });
  });

  test("無い Tera は 404", async () => {
    await withServer(async (harness) => {
      const response = await harness.request("/api/teras/missing/messages?limit=2");
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("tera_not_found");
    });
  });

  test("画面に使わないツールの記録は返さない", async () => {
    await withServer(async (harness) => {
      const text: TextPart = { type: "text", text: "本文", at: 1 };
      const notice: NoticePart = { type: "notice", text: "注記", at: 2 };
      const uiCall: MessagePart = {
        type: "tool-call",
        id: "ui-1",
        server: "chat",
        tool: "ui",
        args: { markup: "<Card><Text>カード</Text></Card>" },
      };
      const shellCall: MessagePart = {
        type: "tool-call",
        id: "shell-1",
        server: "",
        tool: "bash",
        args: { command: "echo secret" },
      };
      const shellResult: MessagePart = {
        type: "tool-result",
        id: "shell-1",
        server: "",
        tool: "bash",
        failed: false,
        output: "長い出力".repeat(100),
      };

      harness.store.appendMessage({
        id: "a1",
        teraId: TERA,
        role: "assistant",
        content: "",
        parts: [text, uiCall, shellCall, shellResult, notice],
      });

      const page = await pageAt(harness, "?limit=1");
      const parts = page.messages[0]?.parts ?? [];
      expect(parts.map((part) => part.type)).toEqual(["text", "tool-call", "notice"]);
      expect(parts[1]).toEqual(uiCall);

      // 保存した記録は、モデルへ渡すために全部残っている。
      const stored = harness.store.listMessagesPage(TERA, { limit: 1, before: null });
      expect(stored.messages[0]?.parts).toHaveLength(5);
    });
  });
});

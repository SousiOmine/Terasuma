import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import {
  createMessagingTools,
  type MessagingContainer,
  type MessagingToolset,
} from "../src/server/agent/tools/messaging";
import { createFileStore, type FileStore } from "../src/server/computer/files";
import { createImageStore, type ImageStore } from "../src/server/computer/images";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../src/shared/attachments";
import type { OutgoingMessage } from "../src/shared/types";
import { testPng } from "./support";

/**
 * chat_send ツールの確認。
 * モデルを介さずにツールをそのまま呼び、送られるメッセージの形を確かめる。
 */

type ToolContext = { abortSignal?: AbortSignal };

/** 中身を決めたファイルだけを読めるコンテナ。画面は常に 1280x800 の PNG を返す。 */
function createContainer(files: Readonly<Record<string, Uint8Array>>): MessagingContainer {
  return {
    readFile: async (path) => {
      const data = files[path];
      if (data === undefined) throw new Error(`no such file: ${path}`);
      return data;
    },
    screenshot: async () => testPng(1280, 800),
  };
}

type Harness = {
  tools: MessagingToolset;
  sent: OutgoingMessage[];
  images: ImageStore;
  files: FileStore;
};

/** 一時ディレクトリに置き場を作り、ツール一式を渡して確かめる。 */
async function withMessaging(
  contents: Readonly<Record<string, Uint8Array>>,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-messaging-"));

  try {
    const sent: OutgoingMessage[] = [];
    const images = createImageStore(dir);
    const files = createFileStore(dir);
    const tools = createMessagingTools({
      container: createContainer(contents),
      root: "/home/agent",
      images,
      files,
      send: (message) => sent.push(message),
    });

    await run({ tools, sent, images, files });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function callTool(
  tools: ToolSet,
  input: unknown,
  context: ToolContext = {},
): Promise<string> {
  const tool = tools["chat_send"];
  if (tool?.execute === undefined) throw new Error("chat_send が無い");
  return (await tool.execute(input as never, context as never)) as string;
}

describe("chat_send", () => {
  test("文字だけを送れる（前後の空白は落とす）", async () => {
    await withMessaging({}, async ({ tools, sent }) => {
      const result = await callTool(tools, { text: "  こんにちは  " });

      expect(result).toBe("Sent the message to the user.");
      expect(sent).toEqual([{ text: "こんにちは", attachments: [] }]);
    });
  });

  test("コンテナの中のファイルを添付できる", async () => {
    const bytes = new TextEncoder().encode("hello attachment");

    await withMessaging({ "/home/agent/notes.txt": bytes }, async ({ tools, sent, files }) => {
      await callTool(tools, { text: "見てください", files: ["notes.txt"] });

      const message = sent[0];
      expect(message?.text).toBe("見てください");
      const attachment = message?.attachments[0];
      if (attachment === undefined) throw new Error("添付が無い");

      expect(attachment.name).toBe("notes.txt");
      expect(attachment.size).toBe(bytes.length);
      expect(attachment.image).toBeNull();
      expect(attachment.url).toMatch(/^\/api\/files\/[0-9a-f]{64}$/);

      // 実体は置き場にあり、URL から読める。
      const id = attachment.url.slice("/api/files/".length);
      const stored = files.read(id);
      expect(stored?.name).toBe("notes.txt");
      expect(stored?.mime).toContain("text/plain");
      expect(new TextDecoder().decode(stored?.data)).toBe("hello attachment");
    });
  });

  test("~ と相対パスは /home/agent から解決する", async () => {
    const bytes = new TextEncoder().encode("home");

    await withMessaging({ "/home/agent/home.txt": bytes }, async ({ tools, sent }) => {
      await callTool(tools, { files: ["~/home.txt", "./home.txt"] });
      expect(sent[0]?.attachments).toHaveLength(2);
      expect(sent[0]?.attachments.every((attachment) => attachment.name === "home.txt")).toBe(true);
    });
  });

  test("画像は写真として、縦横を添えて送る", async () => {
    const png = testPng(4, 3);

    await withMessaging({ "/home/agent/picture.png": png }, async ({ tools, sent, images }) => {
      await callTool(tools, { files: ["picture.png"] });

      const attachment = sent[0]?.attachments[0];
      if (attachment === undefined) throw new Error("添付が無い");
      expect(attachment.name).toBe("picture.png");
      expect(attachment.image).toEqual({ width: 4, height: 3 });
      expect(attachment.url).toMatch(/^\/api\/images\/[0-9a-f]{64}\.png$/);

      const name = attachment.url.slice("/api/images/".length);
      const stored = images.readByName(name);
      expect(stored?.mime).toBe("image/png");
      expect(stored?.data).toEqual(png);
    });
  });

  test("画面のスクリーンショットを写真として送れる", async () => {
    await withMessaging({}, async ({ tools, sent }) => {
      await callTool(tools, { text: "いまの画面です", screenshot: true });

      const attachment = sent[0]?.attachments[0];
      if (attachment === undefined) throw new Error("添付が無い");
      expect(attachment.name).toBe("screenshot.png");
      expect(attachment.image).toEqual({ width: 1280, height: 800 });
    });
  });

  test("文字もファイルも画面も無ければ送らない", async () => {
    await withMessaging({}, async ({ tools, sent }) => {
      await expect(callTool(tools, { text: "   " })).rejects.toThrow("empty");
      expect(sent).toEqual([]);
    });
  });

  test("読めないファイルは送らずに失敗する", async () => {
    await withMessaging({}, async ({ tools, sent }) => {
      await expect(callTool(tools, { files: ["missing.txt"] })).rejects.toThrow("no such file");
      expect(sent).toEqual([]);
    });
  });

  test("添付の数と大きさの上限を守る", async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);

    await withMessaging({ "/home/agent/big.bin": big }, async ({ tools, sent }) => {
      await expect(callTool(tools, { files: ["big.bin"] })).rejects.toThrow("smaller");

      const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => `file-${index}.txt`);
      await expect(callTool(tools, { files: many })).rejects.toThrow("up to");
      expect(sent).toEqual([]);
    });
  });

  test("停止されたターンでは、読み込みの途中でも送らない", async () => {
    await withMessaging({}, async ({ tools, sent }) => {
      const abort = new AbortController();
      abort.abort();

      await expect(callTool(tools, { text: "送れない", screenshot: true }, { abortSignal: abort.signal })).rejects.toThrow(
        "aborted",
      );
      expect(sent).toEqual([]);
    });
  });
});

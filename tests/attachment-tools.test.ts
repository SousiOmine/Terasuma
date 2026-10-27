import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import {
  createAttachmentTools,
  type AttachmentContainer,
  type AttachmentToolset,
} from "../src/server/tools/attachments";
import { createFileStore, type FileStore } from "../src/server/computer/files";
import { createImageStore, type ImageStore } from "../src/server/computer/images";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../src/shared/attachments";
import type { SentAttachment } from "../src/shared/api/message";
import { testPng } from "./support";

/**
 * chat_attach ツールの確認。
 * モデルを介さずにツールをそのまま呼び、添付されるファイルの形を確かめる。
 */

type ToolContext = { abortSignal?: AbortSignal };

/** 中身を決めたファイルだけを読めるコンテナ。画面は常に 1280x800 の PNG を返す。 */
function createContainer(files: Readonly<Record<string, Uint8Array>>): AttachmentContainer {
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
  tools: AttachmentToolset;
  attached: SentAttachment[];
  images: ImageStore;
  files: FileStore;
};

/** 一時ディレクトリに置き場を作り、ツール一式を渡して確かめる。 */
async function withAttachments(
  contents: Readonly<Record<string, Uint8Array>>,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-attachments-"));

  try {
    const attached: SentAttachment[] = [];
    const images = createImageStore(dir);
    const files = createFileStore(dir);
    const tools = createAttachmentTools({
      container: createContainer(contents),
      root: "/home/agent/teras/default",
      images,
      files,
      attach: (attachments) => attached.push(...attachments),
    });

    await run({ tools, attached, images, files });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function callTool(tools: ToolSet, input: unknown, context: ToolContext = {}): Promise<string> {
  const tool = tools["chat_attach"];
  if (tool?.execute === undefined) throw new Error("chat_attach が無い");
  return (await tool.execute(input as never, context as never)) as string;
}

describe("chat_attach", () => {
  test("コンテナの中のファイルを添付できる", async () => {
    const bytes = new TextEncoder().encode("hello attachment");

    await withAttachments({ "/home/agent/teras/default/notes.txt": bytes }, async ({ tools, attached, files }) => {
      const result = await callTool(tools, { files: ["notes.txt"] });

      expect(result).toBe("Attached 1 file to the chat.");
      const attachment = attached[0];
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

  test("相対パスは作業フォルダから、~ はコンテナのホームから解決する", async () => {
    const workspace = new TextEncoder().encode("workspace");
    const home = new TextEncoder().encode("home");

    await withAttachments(
      { "/home/agent/teras/default/home.txt": workspace, "/home/agent/home.txt": home },
      async ({ tools, attached }) => {
        await callTool(tools, { files: ["./home.txt", "~/home.txt"] });

        expect(attached).toHaveLength(2);
        expect(attached.every((attachment) => attachment.name === "home.txt")).toBe(true);
        // 相対パスは作業フォルダのファイル、~ はホームのファイルを読む。
        expect(attached[0]?.size).toBe(workspace.length);
        expect(attached[1]?.size).toBe(home.length);
      },
    );
  });

  test("画像は写真として、縦横を添えて添付する", async () => {
    const png = testPng(4, 3);

    await withAttachments({ "/home/agent/teras/default/picture.png": png }, async ({ tools, attached, images }) => {
      await callTool(tools, { files: ["picture.png"] });

      const attachment = attached[0];
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

  test("画面のスクリーンショットを写真として添付できる", async () => {
    await withAttachments({}, async ({ tools, attached }) => {
      const result = await callTool(tools, { screenshot: true });

      expect(result).toBe("Attached 1 file to the chat.");
      const attachment = attached[0];
      if (attachment === undefined) throw new Error("添付が無い");
      expect(attachment.name).toBe("screenshot.png");
      expect(attachment.image).toEqual({ width: 1280, height: 800 });
    });
  });

  test("ファイルも画面も無ければ添付しない", async () => {
    await withAttachments({}, async ({ tools, attached }) => {
      await expect(callTool(tools, {})).rejects.toThrow("Attach at least one");
      await expect(callTool(tools, { files: [] })).rejects.toThrow("Attach at least one");
      expect(attached).toEqual([]);
    });
  });

  test("読めないファイルは添付せずに失敗する", async () => {
    await withAttachments({}, async ({ tools, attached }) => {
      await expect(callTool(tools, { files: ["missing.txt"] })).rejects.toThrow("no such file");
      expect(attached).toEqual([]);
    });
  });

  test("添付の数と大きさの上限を守る", async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);

    await withAttachments({ "/home/agent/teras/default/big.bin": big }, async ({ tools, attached }) => {
      await expect(callTool(tools, { files: ["big.bin"] })).rejects.toThrow("smaller");

      const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => `file-${index}.txt`);
      await expect(callTool(tools, { files: many })).rejects.toThrow("up to");
      expect(attached).toEqual([]);
    });
  });

  test("停止されたターンでは、読み込みの途中でも添付しない", async () => {
    await withAttachments({}, async ({ tools, attached }) => {
      const abort = new AbortController();
      abort.abort();

      await expect(callTool(tools, { screenshot: true }, { abortSignal: abort.signal })).rejects.toThrow("aborted");
      expect(attached).toEqual([]);
    });
  });
});

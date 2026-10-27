import { posix } from "node:path";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES } from "../../shared/attachments";
import { throwIfAborted } from "../../shared/async";
import { formatBytes } from "../../shared/text";
import { ATTACH_TOOL_NAME } from "../../shared/tools";
import type { SentAttachment } from "../../shared/api/message";
import type { ImageStore } from "../computer/images";
import { imageUrl } from "../computer/images";
import type { FileStore } from "../computer/files";
import { safeFileName } from "../computer/uploads";
import { resolveToolPath } from "./coding";

/**
 * エージェントからユーザーへ、画像やファイルをチャットへ添付するツール。
 *
 * モデルの本文は普通のテキストとして画面に出る。このツールは添付だけを扱う。
 * コンピュータの中のファイル（画像は写真として、それ以外はダウンロードできる
 * ファイルとして）と、いまの画面のスクリーンショットを添付できる。
 *
 * 添付そのもの（保存と画面への通知）はターンの側が受け持つ。ここは材料を読み、
 * 参照を作って attach に渡すだけにする。
 */

/** モデルへ渡すツール。キーはツール名（"chat_attach"）。 */
export type AttachmentToolset = ToolSet;

/** 拡張子から画像と分かるもの。画像は ImageStore、それ以外は FileStore に置く。 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 添付に必要なコンテナの口。 */
export type AttachmentContainer = {
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  screenshot(): Promise<Uint8Array>;
};

export type AttachmentToolsetOptions = {
  container: AttachmentContainer;
  /** 相対パスと ~ の基準（コンピュータの中の絶対パス）。 */
  root: string;
  images: ImageStore;
  files: FileStore;
};

/** 1 ターン分の添付ツールを作る。attach はターンごとに差し替わる。 */
export function createAttachmentTools(
  options: AttachmentToolsetOptions & { attach: (attachments: SentAttachment[]) => void },
): AttachmentToolset {
  const { container, root, images, files, attach } = options;

  return {
    [ATTACH_TOOL_NAME]: tool({
      description: [
        "Attach images or files to the chat.",
        "Your normal text is already shown to the user; use this tool only when the user should see a file or the current screen.",
        "Put paths inside the computer in files. Images are shown as photos; other files are offered for download.",
        "Set screenshot to true to attach the current computer screen.",
      ].join(" "),
      inputSchema: z.object({
        files: z.array(z.string()).optional().describe("Paths inside the computer to attach (relative or absolute)."),
        screenshot: z.boolean().optional().describe("Also attach a screenshot of the current screen."),
      }),
      execute: async (
        { files: paths, screenshot }: { files?: string[]; screenshot?: boolean },
        context: { abortSignal?: AbortSignal },
      ) => {
        throwIfAborted(context.abortSignal);

        const requested = paths ?? [];
        if (requested.length === 0 && screenshot !== true) {
          throw new Error("Attach at least one file or the screen.");
        }
        if (requested.length + (screenshot === true ? 1 : 0) > MAX_ATTACHMENTS) {
          throw new Error(`You can attach up to ${MAX_ATTACHMENTS} files in one call.`);
        }

        const attachments: SentAttachment[] = [];
        let total = 0;

        const add = (data: Uint8Array, name: string): void => {
          if (data.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(`Each file must be ${formatBytes(MAX_ATTACHMENT_BYTES)} or smaller.`);
          }
          total += data.length;
          if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
            throw new Error(`The files must total ${formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES)} or less.`);
          }

          const safeName = safeFileName(name);
          const imageMime = IMAGE_MIME_BY_EXTENSION[posix.extname(safeName).toLowerCase()];
          if (imageMime === undefined) {
            const stored = files.save(data, safeName);
            attachments.push({ name: stored.name, size: stored.size, url: stored.url, image: null });
            return;
          }

          const ref = images.save(data, imageMime);
          attachments.push({
            name: safeName,
            size: data.length,
            url: imageUrl(ref),
            image: { width: ref.width, height: ref.height },
          });
        };

        if (screenshot === true) {
          const screen = await container.screenshot();
          throwIfAborted(context.abortSignal);
          add(screen, "screenshot.png");
        }

        for (const requestedPath of requested) {
          const target = resolveToolPath(requestedPath, root);
          const data = await container.readFile(target, context.abortSignal);
          throwIfAborted(context.abortSignal);
          add(data, posix.basename(target));
        }

        attach(attachments);
        return attachments.length === 1
          ? "Attached 1 file to the chat."
          : `Attached ${attachments.length} files to the chat.`;
      },
    }),
  };
}

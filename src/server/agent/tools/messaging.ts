import { posix } from "node:path";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  formatBytes,
} from "../../../shared/attachments";
import { SEND_MESSAGE_TOOL_NAME } from "../../../shared/tools";
import type { OutgoingMessage, SentAttachment } from "../../../shared/types";
import type { ImageStore } from "../../computer/images";
import { imageUrl } from "../../computer/images";
import type { FileStore } from "../../computer/files";
import { safeFileName } from "../../computer/uploads";
import { resolveToolPath } from "./coding";

/**
 * エージェントからユーザーへ、チャットのメッセージを送るツール。
 *
 * モデルの本文（content）は画面に出さない。ユーザーへ届くのは、このツールで送った
 * メッセージだけになる。文字だけでなく、コンピュータの中のファイル（画像は写真として、
 * それ以外はダウンロードできるファイルとして）と、いまの画面のスクリーンショットを送れる。
 *
 * 送信そのもの（保存と画面への通知）はターンの側が受け持つ。ここは材料を読み、
 * 参照を作って send に渡すだけにする。
 */

/** モデルへ渡すツール。キーはツール名（"chat_send"）。 */
export type MessagingToolset = ToolSet;

/** 拡張子から画像と分かるもの。画像は ImageStore、それ以外は FileStore に置く。 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 送信に必要なコンテナの口。 */
export type MessagingContainer = {
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  screenshot(): Promise<Uint8Array>;
};

export type MessagingToolsetOptions = {
  container: MessagingContainer;
  /** 相対パスと ~ の基準（コンピュータの中の絶対パス）。 */
  root: string;
  images: ImageStore;
  files: FileStore;
};

/** 1 ターン分の送信ツールを作る。send はターンごとに差し替わる。 */
export function createMessagingTools(
  options: MessagingToolsetOptions & { send: (message: OutgoingMessage) => void },
): MessagingToolset {
  const { container, root, images, files, send } = options;

  return {
    [SEND_MESSAGE_TOOL_NAME]: tool({
      description: [
        "Send a message to the user in the chat.",
        "This is the only way the user sees anything: your plain text output is never shown to the user.",
        "Use it for every reply. Keep each message short, like a chat message, and send several messages when that reads better.",
        "Put paths inside the computer in files to attach them. Images are shown as photos; other files are offered for download.",
        "Set screenshot to true to attach the current computer screen.",
      ].join(" "),
      inputSchema: z.object({
        text: z.string().optional().describe("The message text the user reads. Leave empty when you only send files."),
        files: z
          .array(z.string())
          .optional()
          .describe("Paths inside the computer to send (relative or absolute)."),
        screenshot: z.boolean().optional().describe("Also attach a screenshot of the current screen."),
      }),
      execute: async (
        {
          text,
          files: paths,
          screenshot,
        }: { text?: string; files?: string[]; screenshot?: boolean },
        context: { abortSignal?: AbortSignal },
      ) => {
        throwIfAborted(context.abortSignal);

        const body = text?.trim() ?? "";
        const requested = paths ?? [];
        if (body.length === 0 && requested.length === 0 && screenshot !== true) {
          throw new Error("Send some text, a file, or a screenshot: the message would be empty.");
        }
        if (requested.length + (screenshot === true ? 1 : 0) > MAX_ATTACHMENTS) {
          throw new Error(`You can send up to ${MAX_ATTACHMENTS} files in one message.`);
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

        send({ text: body, attachments });
        return "Sent the message to the user.";
      },
    }),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("Operation aborted because the turn stopped");
}

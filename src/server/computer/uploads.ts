import { posix } from "node:path";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES } from "../../shared/attachments";
import { formatBytes } from "../../shared/text";
import type { ChatAttachment } from "../../shared/api/message";
import { ValidationError } from "../errors";
import type { ContainerManager } from "./container";
import { teraWorkspaceInContainer } from "./workspaces";

/**
 * チャットへ添付されたファイルを、エージェントが操作するコンテナの中へ置く。
 *
 * 置き場は、その Tera の作業フォルダの中の uploads/<受付ごとのフォルダ>/ にする
 * （/home/agent/teras/<tera id>/uploads/...）。送られたファイルが、その Tera の
 * 作業材料として 1 か所にまとまる。
 * ホームはホストのデータディレクトリにマウントされているので、コンテナを作り直しても残る。
 *
 * ファイル名は画面から来た値をそのまま使わない。パス区切りを落とし、
 * 同じ受付の中では連番を頭に付けて、置き場の外を指したり名前が衝突したりしないようにする。
 */

/** 置き場の名前。Tera の作業フォルダの直下に作る。 */
const UPLOADS_DIR_NAME = "uploads";

/** 保存するファイル名のバイト数の上限。ファイルシステムの上限（255 バイト）より十分短くする。 */
const MAX_FILE_NAME_BYTES = 200;

/**
 * 送信本文全体の上限。ファイルの合計に multipart の区切りと本文を足した分を見込む。
 * Bun の既定は 128MB なので、それより小さくして、読み込みすぎを防ぐ。
 */
export const MAX_REQUEST_BODY_BYTES = MAX_ATTACHMENTS_TOTAL_BYTES + 8 * 1024 * 1024;

/** 画面から受け取った、まだ保存していないファイル。 */
export type UploadFile = {
  /** 画面でのファイル名。保存名ではなく、通知に出す名前。 */
  name: string;
  bytes: Uint8Array;
};

/** 保存に使うコンテナの口。テストでは書き込みだけを差し替える。 */
export type UploadWriter = Pick<ContainerManager, "writeFile">;

/**
 * multipart の本文から、添付ファイルを取り出す。
 * 数と大きさは、バイト列を読む前に確かめる（大きすぎる本文を抱え込まないため）。
 */
export async function readUploadedFiles(form: FormData): Promise<UploadFile[]> {
  const entries = form.getAll("files");
  if (entries.some((entry) => typeof entry === "string")) {
    throw new ValidationError("files must be uploaded as files");
  }

  const files = entries as File[];
  assertLimits(files.map((file) => file.size));

  const uploaded: UploadFile[] = [];
  for (const file of files) {
    uploaded.push({
      name: file.name.length === 0 ? "file" : file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return uploaded;
}

/**
 * ファイルをコンテナへ置く。置き場は、その Tera の作業フォルダの中。
 * 1 つでも書けなければ例外にし、途中まで置いたファイルは残る（会話は始めない）。
 */
export async function saveUploads(
  container: UploadWriter,
  teraId: string,
  files: readonly UploadFile[],
  signal: AbortSignal,
): Promise<ChatAttachment[]> {
  assertLimits(files.map((file) => file.bytes.length));
  if (files.length === 0) return [];

  const workspace = teraWorkspaceInContainer(teraId);
  const folder = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const saved: ChatAttachment[] = [];

  for (const [index, file] of files.entries()) {
    const safeName = safeFileName(file.name);
    const storedName = `${String(index + 1).padStart(2, "0")}-${safeName}`;
    const path = posix.join(workspace, UPLOADS_DIR_NAME, folder, storedName);

    await container.writeFile(path, file.bytes, signal);
    saved.push({ name: safeName, path, size: file.bytes.length });
  }

  return saved;
}

/** 数と大きさの上限を確かめる。超えていれば、画面にそのまま出せる理由で止める。 */
function assertLimits(sizes: readonly number[]): void {
  if (sizes.length > MAX_ATTACHMENTS) {
    throw new ValidationError(`You can attach up to ${MAX_ATTACHMENTS} files`);
  }

  let total = 0;
  for (const size of sizes) {
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new ValidationError(`Each file must be ${formatBytes(MAX_ATTACHMENT_BYTES)} or smaller`);
    }
    total += size;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new ValidationError(`The attachments must total ${formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES)} or less`);
    }
  }
}

/**
 * 画面から来た名前を、1 つのファイル名として安全な形にする。
 * パス区切りは落とし、制御文字は置き換える。空・`.`・`..` は `file` にする。
 */
export function safeFileName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? "";
  // 制御文字はファイル名として扱いが曖昧なので、1 文字ずつ見て置き換える。
  const cleaned = Array.from(base, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? "_" : char;
  })
    .join("")
    .trim();
  const name = cleaned.length === 0 || cleaned === "." || cleaned === ".." ? "file" : cleaned;
  return truncateToBytes(name, MAX_FILE_NAME_BYTES);
}

/** 文字の境目を壊さずに、UTF-8 のバイト数で名前を切る。 */
function truncateToBytes(text: string, maxBytes: number): string {
  let used = 0;
  let result = "";

  for (const char of text) {
    const size = Buffer.byteLength(char, "utf-8");
    if (used + size > maxBytes) break;
    used += size;
    result += char;
  }
  return result;
}

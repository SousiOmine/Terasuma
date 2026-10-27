import { posix } from "node:path";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { throwIfAborted } from "../../shared/async";
import type { ToolContext } from "./context";
import { formatBytes } from "../../shared/text";
import { appendStatus, formatBashOutput } from "./bash-output";
import { z } from "zod";
import type { ShellResult } from "../computer/exec";
import { WORKDIR_IN_CONTAINER } from "../computer/contract";

/**
 * エージェントが、Debian のデスクトップコンテナの中のファイルを読み書きし、
 * その中でシェルを実行するためのツールセット（read / write / edit / bash）。
 *
 * ファイルもコマンドも、すべて podman exec でコンピュータのコンテナの中に入って行う。
 * Terasuma 本体が動いているホストや、アプリのコンテナのファイルには触れない。
 * コンテナが動いていなければ、どのツールも理由付きで失敗する（ホストへは落ちない）。
 *
 * 相対パスと bash の作業ディレクトリは、渡された root（Tera の作業フォルダ）を基準にする。
 * ~ はコンテナのホーム（/home/agent）に広げる（bash の ~ と同じ場所）。
 * 絶対パスは制限しないので、ほかの Tera の作業フォルダにも触れられる。
 */

/** モデルへ渡すツール。キーはツール名（"read" など）。 */
export type CodingToolset = ToolSet;

/** ファイルとシェルを実行するコンテナ。テストではローカルの差し替えを渡す。 */
export type CodingContainer = {
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array, signal?: AbortSignal): Promise<void>;
  shell(
    script: string,
    options: { timeoutMs: number; signal?: AbortSignal; maxOutputChars?: number; workdir?: string },
  ): Promise<ShellResult>;
};

export type CodingToolsetOptions = {
  /** ファイルとシェルを実行するコンテナ。 */
  container: CodingContainer;
  /** 相対パスと ~ の基準（コンテナ内の絶対パス）。 */
  root: string;
};

/** read が 1 回で返す行数の上限。 */
export const READ_MAX_LINES = 2_000;
/** read が 1 回で返すバイト数の上限。 */
export const READ_MAX_BYTES = 50 * 1024;
/** bash が返す出力の行数の上限。 */
export const BASH_MAX_LINES = 2_000;
/** bash が返す出力のバイト数の上限。 */
export const BASH_MAX_BYTES = 50 * 1024;
/** bash の既定の待ち時間。 */
export const BASH_TIMEOUT_MS = 120_000;
/** bash に指定できる待ち時間の上限（秒）。 */
const BASH_MAX_TIMEOUT_SECONDS = 600;
/** bash の出力を、表示用に詰める前まで受け取る上限（文字数）。 */
const BASH_RAW_OUTPUT_CHARS = 1_000_000;

/** モデルへ見せるバイト数（pi と同じ、空白を詰めた形）。 */
function formatSize(bytes: number): string {
  return formatBytes(bytes, { space: false });
}

const BOM = "\uFEFF";

/** UTF-8 のデコード。BOM は残す（edit が BOM を見て、元のファイルに合わせて戻すため）。 */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** ツールの実行に渡ってくる中断。ターンが止まったら、ファイル操作もコマンドも打ち切る。 */

export function createCodingToolset({ container, root }: CodingToolsetOptions): CodingToolset {
  const where = `Paths are relative to ${root} unless absolute; ~ is ${WORKDIR_IN_CONTAINER}.`;

  return {
    read: tool({
      description: [
        "Read the contents of a text file inside the Debian computer that you operate.",
        where,
        `Output is truncated to ${READ_MAX_LINES} lines or ${formatSize(READ_MAX_BYTES)} (whichever is hit first).`,
        "Use offset/limit for large files. When you need the full file, continue with offset until complete.",
      ].join(" "),
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to the file to read (relative or absolute)"),
        offset: z.number().int().min(1).optional().describe("Line number to start reading from (1-indexed)"),
        limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
      }),
      execute: async (
        { path, offset, limit }: { path: string; offset?: number; limit?: number },
        context: ToolContext,
      ) => {
        throwIfAborted(context.abortSignal);
        const target = resolveToolPath(path, root);
        const buffer = await container.readFile(target, context.abortSignal);
        throwIfAborted(context.abortSignal);
        return readTextFile(target, buffer, offset, limit);
      },
    }),

    write: tool({
      description: [
        "Write content to a file inside the Debian computer that you operate.",
        where,
        "Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      ].join(" "),
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to the file to write (relative or absolute)"),
        content: z.string().describe("Content to write to the file"),
      }),
      execute: async ({ path, content }: { path: string; content: string }, context: ToolContext) => {
        throwIfAborted(context.abortSignal);
        const output = await writeTextFile(container, resolveToolPath(path, root), content, context.abortSignal);
        throwIfAborted(context.abortSignal);
        return output;
      },
    }),

    edit: tool({
      description: [
        "Edit a single file inside the Debian computer that you operate using exact text replacement.",
        where,
        "oldText must match a unique region of the original file.",
        "Include enough surrounding text to make it unique, but do not include large unchanged regions just to connect distant changes.",
        "Line endings and a BOM are preserved.",
      ].join(" "),
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to the file to edit (relative or absolute)"),
        oldText: z
          .string()
          .describe("Exact text for one targeted replacement. It must be unique in the original file."),
        newText: z.string().describe("Replacement text for this targeted edit."),
      }),
      execute: async (
        { path, oldText, newText }: { path: string; oldText: string; newText: string },
        context: ToolContext,
      ) => {
        throwIfAborted(context.abortSignal);
        const output = await editTextFile(
          container,
          resolveToolPath(path, root),
          oldText,
          newText,
          context.abortSignal,
        );
        throwIfAborted(context.abortSignal);
        return output;
      },
    }),

    bash: tool({
      description: [
        "Execute a bash command inside the Debian computer that you operate.",
        `Commands run as bash -lc in ${root}, and sudo works without a password.`,
        "This is the same machine that the computer_ tools control; it is not the machine Terasuma runs on.",
        "Returns stdout and stderr combined.",
        `Output is truncated to the last ${BASH_MAX_LINES} lines or ${formatSize(BASH_MAX_BYTES)} (whichever is hit first); the beginning is omitted.`,
        `Optionally provide a timeout in seconds (default: ${BASH_TIMEOUT_MS / 1000}, max: ${BASH_MAX_TIMEOUT_SECONDS}).`,
      ].join(" "),
      inputSchema: z.object({
        command: z.string().min(1).describe("Shell command to execute"),
        timeout: z
          .number()
          .min(0.1)
          .max(BASH_MAX_TIMEOUT_SECONDS)
          .optional()
          .describe(`Timeout in seconds (default: ${BASH_TIMEOUT_MS / 1000}, max: ${BASH_MAX_TIMEOUT_SECONDS})`),
      }),
      execute: async ({ command, timeout }: { command: string; timeout?: number }, context: ToolContext) => {
        throwIfAborted(context.abortSignal);
        const output = await runBash(container, root, command, timeout, context.abortSignal);
        throwIfAborted(context.abortSignal);
        return output;
      },
    }),
  };
}

/**
 * 相対パスを、コンテナの基準ディレクトリ（Tera の作業フォルダ）から解決する。
 * `~` と `~/...` だけはコンテナのホーム（/home/agent）に広げる（bash の ~ と同じ）。
 */
export function resolveToolPath(input: string, root: string): string {
  const path = input.trim();
  if (path.length === 0) throw new Error("path must not be empty");

  const home = WORKDIR_IN_CONTAINER;
  const expanded = path === "~" ? home : path.startsWith("~/") ? posix.join(home, path.slice(2)) : path;
  return posix.resolve(root, expanded);
}

/**
 * テキストを読む。行番号は 1 始まりで、末尾の改行は行として数えない。
 * 大きすぎるファイルは、続きの offset を添えて切る（切ったことを黙らない）。
 */
function readTextFile(path: string, buffer: Uint8Array, offset: number | undefined, limit: number | undefined): string {
  if (buffer.includes(0)) {
    throw new Error(`${path} is a binary file; this tool reads text files only`);
  }

  const text = UTF8.decode(buffer);
  const lines = text.split("\n");
  const trailingNewline = text.endsWith("\n");
  if (trailingNewline) lines.pop();

  const total = lines.length;
  const start = (offset ?? 1) - 1;
  if (start >= total) {
    throw new Error(`Offset ${offset} is beyond end of file (${total} lines total)`);
  }

  const end = limit === undefined ? total : Math.min(start + limit, total);
  const selected = lines.slice(start, end);

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;

  for (const line of selected) {
    if (kept.length >= READ_MAX_LINES) {
      truncatedBy = "lines";
      break;
    }

    const size = Buffer.byteLength(line, "utf-8") + (kept.length === 0 ? 0 : 1);
    if (bytes + size > READ_MAX_BYTES) {
      if (kept.length === 0) {
        throw new Error(
          `[Line ${start + 1} is ${formatSize(Buffer.byteLength(line, "utf-8"))}, exceeds ${formatSize(READ_MAX_BYTES)} limit. ` +
            `Use bash: sed -n '${start + 1}p' ${path} | head -c ${READ_MAX_BYTES}]`,
        );
      }
      truncatedBy = "bytes";
      break;
    }

    kept.push(line);
    bytes += size;
  }

  const output = kept.join("\n");

  if (truncatedBy !== null) {
    const nextOffset = start + kept.length + 1;
    const limitNote = truncatedBy === "bytes" ? ` (${formatSize(READ_MAX_BYTES)} limit)` : "";
    return `${output}\n\n[Showing lines ${start + 1}-${start + kept.length} of ${total}${limitNote}. Use offset=${nextOffset} to continue.]`;
  }

  if (end < total) {
    const remaining = total - end;
    return `${output}\n\n[${remaining} more lines in file. Use offset=${end + 1} to continue.]`;
  }

  return trailingNewline && end === total ? `${output}\n` : output;
}

/** ファイルを書く。親ディレクトリが無ければ作る（write は新しいファイル向け）。 */
async function writeTextFile(
  container: CodingContainer,
  path: string,
  content: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);

  await container.writeFile(path, Buffer.from(content, "utf-8"), signal);
  throwIfAborted(signal);

  return `Successfully wrote to ${path}`;
}

/**
 * ファイルの中の 1 か所を置き換える。
 * 改行コードと BOM は元のファイルに合わせて戻す（モデルは LF で書いてくるため）。
 * oldText が見つからない・一意でない場合は、直せることが分かる理由で止める。
 */
async function editTextFile(
  container: CodingContainer,
  path: string,
  oldText: string,
  newText: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);

  const raw = UTF8.decode(await container.readFile(path, signal));
  throwIfAborted(signal);

  const bom = raw.startsWith(BOM) ? BOM : "";
  const text = bom === "" ? raw : raw.slice(BOM.length);
  const ending = detectLineEnding(text);

  const normalized = normalizeToLf(text);
  const oldNormalized = normalizeToLf(oldText);
  const newNormalized = normalizeToLf(newText);

  if (oldNormalized.length === 0) throw new Error(`oldText must not be empty in ${path}.`);

  const occurrences = normalized.split(oldNormalized).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }

  const index = normalized.indexOf(oldNormalized);
  const next = normalized.slice(0, index) + newNormalized + normalized.slice(index + oldNormalized.length);
  if (next === normalized) {
    throw new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }

  await container.writeFile(path, Buffer.from(bom + restoreLineEndings(next, ending), "utf-8"), signal);
  throwIfAborted(signal);

  return `Successfully replaced 1 block(s) in ${path}.`;
}

/** ファイルの最初の改行で、CRLF か LF かを決める。 */
function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlf = text.indexOf("\r\n");
  if (crlf === -1) return "\n";

  const lf = text.indexOf("\n");
  return crlf < lf ? "\r\n" : "\n";
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** コンテナの中で bash を実行し、結果をモデルが読める形にする。 */
async function runBash(
  container: CodingContainer,
  workdir: string,
  command: string,
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const timeoutMs = (timeoutSeconds ?? BASH_TIMEOUT_MS / 1000) * 1000;

  // pi と同じく、標準出力と標準エラーは到着順のまま 1 本にまとめる。
  // シェルの stderr を最初に stdout へ寄せ、コンテナからは 1 本の流れとして受け取る。
  const result = await container.shell(`exec 2>&1\n${command}`, {
    timeoutMs,
    signal,
    // 表示用に詰めるのは 2,000 行 / 50 KB だが、その手前で末尾 1 MB まで受け取る。
    maxOutputChars: BASH_RAW_OUTPUT_CHARS,
    // 相対パスの基準（root）と同じフォルダで動かす。
    workdir,
  });

  const output = formatBashOutput(result, { maxLines: BASH_MAX_LINES, maxBytes: BASH_MAX_BYTES });

  if (signal?.aborted === true) throw new Error(appendStatus(output, "Command aborted"));
  if (result.timedOut) {
    throw new Error(appendStatus(output, `Command timed out after ${timeoutMs / 1000} seconds`));
  }
  if (result.exitCode !== 0) {
    throw new Error(appendStatus(output, `Command exited with code ${result.exitCode}`));
  }

  return output;
}


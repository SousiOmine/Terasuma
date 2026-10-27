import { formatBytes, truncateBytesFromEnd } from "../../shared/text";
import type { ShellResult } from "../computer/container";

/**
 * bash の出力を、モデルが読める形に整える。
 *
 * 出力は末尾に結論が出るので、上限を超えたら先頭を落とす。落としたことは必ず本文に残す
 * （結果が途中であることを、モデルが利用者へ説明できるように）。
 * 終了コードや打ち切りも、本文の末尾に添える（pi の bash と同じ形に揃える）。
 */

/** 整えるのに使う上限。coding.ts が持つ値を渡す（ツールの説明と同じ値を使う）。 */
export type BashLimits = { maxLines: number; maxBytes: number };

/** バイト数を、ツールの戻り値向けの詰めた表記にする（`50.0KB`）。 */
function formatSize(bytes: number): string {
  return formatBytes(bytes, { space: false });
}

/**
 * 標準出力と標準エラーを 1 つの本文にし、末尾 2,000 行 / 50 KB へ詰める。
 * 先頭を落としたときは、そのことを結果に残す（結果が途中であることをモデルが説明できるように）。
 */
export function formatBashOutput(result: ShellResult, limits: BashLimits): string {
  // stderr は exec 2>&1 で stdout に寄るが、シェル自体を起動できなかった場合は stderr に残る。
  const combined = result.stdout + result.stderr;
  const tail = truncateTail(combined, limits.maxLines, limits.maxBytes);
  const text = tail.content.length === 0 ? "(no output)" : tail.content;
  if (!tail.truncated) return text;

  const limitNote = tail.truncatedBy === "bytes" ? ` (${formatSize(limits.maxBytes)} limit)` : "";
  return `${text}\n\n[Showing lines ${tail.startLine}-${tail.endLine} of ${tail.totalLines}${limitNote}. The beginning was omitted.]`;
}

/** pi の bash と同じく、終了コードや打ち切りは本文の末尾に添える。 */
export function appendStatus(text: string, status: string): string {
  return text.length === 0 ? status : `${text}\n\n${status}`;
}

type TailTruncation = {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  startLine: number;
  endLine: number;
};

/** 末尾から行とバイト数の上限まで残す。1 行だけで上限を超える場合は、その行の末尾を残す。 */
function truncateTail(content: string, maxLines: number, maxBytes: number): TailTruncation {
  if (content.length === 0) {
    return { content: "", truncated: false, truncatedBy: null, totalLines: 0, startLine: 0, endLine: 0 };
  }

  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailingNewline) lines.pop();

  const totalLines = lines.length;
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (kept.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }

    const line = lines[index];
    if (line === undefined) continue;

    const size = Buffer.byteLength(line, "utf-8") + (kept.length === 0 ? 0 : 1);
    if (bytes + size > maxBytes) {
      if (kept.length === 0) {
        const tail = truncateBytesFromEnd(line, maxBytes);
        kept.unshift(tail);
        bytes = Buffer.byteLength(tail, "utf-8");
        truncatedBy = "bytes";
      } else {
        truncatedBy = "bytes";
      }
      break;
    }

    kept.unshift(line);
    bytes += size;
  }

  return {
    content: kept.join("\n"),
    truncated: truncatedBy !== null,
    truncatedBy,
    totalLines,
    startLine: totalLines - kept.length + 1,
    endLine: totalLines,
  };
}

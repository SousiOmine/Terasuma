import { isRecord } from "../../shared/guards";
import { describeError } from "../../shared/errors";

/**
 * SKILL.md の YAML frontmatter を読む・書く。
 *
 * スキルの一覧に使うのは name と description だけで、本文は別に持つ。
 * 分割と解析をここに固めておくと、走査（scan）と更新（update）が同じ規則を使える。
 * 解析は YAML の実装（Bun.YAML）に任せ、ここでは「形が違えば理由を返す」だけを決める。
 */

/** 分割した frontmatter と本文。 */
export type SplitFrontmatter = { yaml: string; body: string };

/**
 * 先頭の `---` と次の `---` で分ける。
 * BOM と CRLF は落としてから見る（手で書いたファイルでも同じように読めるように）。
 */
export function splitFrontmatter(text: string): SplitFrontmatter | null {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0]?.trimEnd() !== "---") return null;

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trimEnd() !== "---") continue;
    return {
      yaml: lines.slice(1, index).join("\n"),
      body: lines
        .slice(index + 1)
        .join("\n")
        .trim(),
    };
  }

  return null;
}

/** frontmatter を読んだ結果。壊れていれば理由を返す（アプリ全体は止めない）。 */
export type FrontmatterRead =
  | { kind: "ok"; data: Record<string, unknown>; body: string }
  | { kind: "problem"; reason: string };

/** SKILL.md の本文から、frontmatter の対応表と本文を取り出す。 */
export function readFrontmatter(text: string, fileName: string): FrontmatterRead {
  const split = splitFrontmatter(text);
  if (split === null) return { kind: "problem", reason: `${fileName} has no complete YAML frontmatter` };

  try {
    const parsed = Bun.YAML.parse(split.yaml);
    if (!isRecord(parsed)) return { kind: "problem", reason: "frontmatter is not a mapping" };
    return { kind: "ok", data: parsed, body: split.body };
  } catch (error) {
    return { kind: "problem", reason: `invalid YAML frontmatter: ${describeError(error)}` };
  }
}

/**
 * frontmatter の並びを、読みやすいブロック形式で書く。
 * 本文は 1 つの改行で区切る。
 */
export function formatSkillFile(frontmatter: Record<string, unknown>, content: string): string {
  const yaml = Bun.YAML.stringify(frontmatter, null, 2).trimEnd();
  return `---\n${yaml}\n---\n\n${content.trim()}\n`;
}

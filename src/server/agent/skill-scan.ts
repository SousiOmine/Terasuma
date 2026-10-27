import { readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * スキルのディレクトリの中のファイルを、相対パスで並べる。
 *
 * スキルは SKILL.md のほかに、手順書から参照する同梱ファイル（テンプレートなど）を持てる。
 * 本文を読むときに、その一覧を添えてモデルへ渡す。数と深さに上限を置き、
 * 大きなディレクトリやシンボリックリンクの輪で読み込みが止まらないようにする。
 */

/** 並べる同梱ファイルの上限。 */
const MAX_RESOURCES = 50;
/** 探す深さの上限。 */
const MAX_DEPTH = 4;
/** 見るディレクトリの上限。 */
const MAX_DIRS = 500;

/** SKILL.md と、書き込み途中の一時ファイルは一覧に載せない。 */
const SKIP = new Set(["SKILL.md"]);

export function listSkillResources(dir: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  let directories = 0;
  const stack: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;

    if (current.depth > MAX_DEPTH) {
      truncated = true;
      continue;
    }

    directories += 1;
    if (directories > MAX_DIRS) {
      truncated = true;
      break;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      truncated = true;
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = relative(dir, path).split(sep).join("/");
      if (SKIP.has(relativePath) || relativePath.startsWith(".SKILL.md.")) continue;

      if (files.length >= MAX_RESOURCES) {
        truncated = true;
        break;
      }
      files.push(relativePath);
    }

    if (truncated && files.length >= MAX_RESOURCES) break;
  }

  files.sort((left, right) => left.localeCompare(right));
  return { files, truncated };
}

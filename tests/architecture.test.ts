import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * 依存の向きを守る。
 *
 * 層を分けても、import が自由だと元の形に戻ってしまう。ここで「どの層がどの層を
 * import してよいか」を機械的に確かめる。禁止を破ったときの直し方は 1 つ（依存の向きを戻す）だけ。
 */

const root = join(import.meta.dir, "..");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(path);
  }
  return files;
}

/** ファイルの相対 import を、リポジトリからのパスへ直す。 */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const from = relative(root, file).split("\\").join("/");

  return [...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)].map((match) => {
    const target = relative(root, join(root, dirname(from), match[1] ?? ""))
      .split("\\")
      .join("/");
    return target;
  });
}

/** 指定した接頭辞の中のファイルが、禁止した接頭辞を import していないことを確かめる。 */
function expectNoImports(from: string, forbidden: readonly string[]): void {
  const offenders: string[] = [];

  for (const file of walk(join(root, from))) {
    const where = relative(root, file).split("\\").join("/");
    for (const target of importsOf(file)) {
      if (forbidden.some((prefix) => target === prefix.slice(0, -1) || target.startsWith(prefix))) {
        offenders.push(`${where} → ${target}`);
      }
    }
  }

  expect(offenders).toEqual([]);
}

describe("依存の向き", () => {
  test("shared はサーバもクライアントも知らない", () => {
    expectNoImports("src/shared", ["src/server/", "src/client/"]);
  });

  test("クライアントはサーバを直接 import しない", () => {
    expectNoImports("src/client", ["src/server/"]);
  });

  test("エージェントは HTTP 層を知らない", () => {
    expectNoImports("src/server/agent", ["src/server/http/"]);
  });

  test("永続化は HTTP 層を知らない", () => {
    expectNoImports("src/server/data", ["src/server/http/"]);
  });

  test("プロバイダの種別表は AI SDK を読み込まない", () => {
    const file = join(root, "src/server/provider/kinds.ts");
    const source = readFileSync(file, "utf8");
    // npm 名は表のデータとして載っているので、import の行だけを見る。
    const imported = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");

    expect(
      imported.filter((name) => name === "ai" || name.startsWith("@ai-sdk/") || name.startsWith("@openrouter/")),
    ).toEqual([]);
  });
});

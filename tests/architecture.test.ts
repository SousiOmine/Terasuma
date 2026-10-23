import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { routeProblem } from "../src/server/http/route-problem";

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

  test("shared は node: を読まない", () => {
    const offenders = walk(join(root, "src/shared"))
      .filter((file) => /(?:from|import)\s*\(?\s*["']node:/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file).split("\\").join("/"));

    expect(offenders).toEqual([]);
  });

  test("クライアントはサーバを直接 import しない", () => {
    expectNoImports("src/client", ["src/server/"]);
  });

  test("client を import してよいのは server/http/routes.ts だけ", () => {
    const offenders: string[] = [];

    for (const file of walk(join(root, "src"))) {
      const where = relative(root, file).split("\\").join("/");
      if (where.startsWith("src/client/")) continue;
      if (where === "src/server/http/routes.ts") continue;

      for (const target of importsOf(file)) {
        if (target.startsWith("src/client")) offenders.push(`${where} → ${target}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("ツールはエンジンを知らない（供給元の型は contracts にある）", () => {
    expectNoImports("src/server/agent/tools", ["src/server/agent/engine"]);
  });

  test("画面の実装は通信層を直接呼ばない（state を通す）", () => {
    expectNoImports("src/client/features", ["src/client/lib/api"]);
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

describe("API の配線", () => {
  test("ハンドラ名は重複せず、すべてルート表に 1 回ずつ現れる", async () => {
    const { HANDLER_MODULES } = await import("../src/server/http/handlers");

    // ハンドラの組み立ては依存を読むだけで呼ばない。何を返す差し替えでも足りる。
    const deps = new Proxy({}, { get: () => () => undefined });
    const names = Object.values(HANDLER_MODULES).flatMap((create) => Object.keys(create(deps as never)));

    // 同じ名前のハンドラを 2 つ持つと、スプレッドで片方が黙って消える。
    expect(new Set(names).size).toBe(names.length);

    const source = readFileSync(join(root, "src/server/http/routes.ts"), "utf8");
    const routed = [...source.matchAll(/\bapi\.(\w+)/g)].map((match) => match[1] ?? "");

    // 同じハンドラを 2 つのルートに書いていない。
    expect(new Set(routed).size).toBe(routed.length);
    // 表にあるものはすべてハンドラにあり、ハンドラはすべて表にある。
    expect(new Set(routed)).toEqual(new Set(names));
  });

  test("ルート表に無いパスと、メソッドの合わないパスを区別する", () => {
    const routes = {
      "/api/teras": { GET: () => undefined },
      "/api/teras/:id/messages": { GET: () => undefined, POST: () => undefined },
      "/api/computer/screen/*": { GET: () => undefined },
    };

    expect(routeProblem(routes, "/api/teras", "GET")).toBeNull();
    expect(routeProblem(routes, "/api/teras", "POST")).toBe("method_not_allowed");
    expect(routeProblem(routes, "/api/teras/default/messages", "GET")).toBeNull();
    expect(routeProblem(routes, "/api/teras/default/messages", "DELETE")).toBe("method_not_allowed");
    expect(routeProblem(routes, "/api/computer/screen/novnc/app.js", "GET")).toBeNull();
    expect(routeProblem(routes, "/api/computer/screen/novnc/app.js", "POST")).toBe("method_not_allowed");
    expect(routeProblem(routes, "/api/unknown", "GET")).toBe("not_found");
    expect(routeProblem(routes, "/", "GET")).toBe("not_found");
  });
});

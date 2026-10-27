import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 画面全体の高さとスクロール。
 *
 * dvh を知らないブラウザでも高さが画面に収まり、文書側がスクロールしないことを、
 * styles.css の宣言そのもので確かめる。
 */

const root = join(import.meta.dir, "..", "..");
const css = readFileSync(join(root, "src", "client", "styles.css"), "utf8");

function ruleBody(selector: RegExp): string {
  return css.match(selector)?.[1] ?? "";
}

describe("画面全体のレイアウト", () => {
  test("html, body, #root は 100% を先に、100dvh を後に持つ", () => {
    const body = ruleBody(/html,\s*body,\s*#root\s*\{([^}]*)\}/);
    const percent = body.indexOf("height: 100%;");
    const dvh = body.indexOf("height: 100dvh;");

    expect(percent).toBeGreaterThanOrEqual(0);
    expect(dvh).toBeGreaterThan(percent);
  });

  test("html, body は文書側でスクロールしない", () => {
    const body = ruleBody(/html,\s*body\s*\{([^}]*)\}/);

    expect(body).toContain("overflow: hidden;");
  });
});

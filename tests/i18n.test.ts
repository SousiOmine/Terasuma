import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setLocale, t } from "../src/client/i18n";
import { en } from "../src/client/i18n/en";
import { ja } from "../src/client/i18n/ja";
import { API_ERROR_CODES } from "../src/shared/api/error";

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

/** 画面のコードが参照しているキー。辞書そのものは数えない。 */
function referencedKeys(): Set<string> {
  const keys = new Set<string>();

  for (const file of walk(join(root, "src/client"))) {
    const where = relative(root, file).split("\\").join("/");
    if (where.startsWith("src/client/i18n/")) continue;

    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)"/g)) {
      const key = match[1];
      if (key !== undefined) keys.add(key);
    }
  }

  // 失敗の文言は `error.${code}` で組み立てるので、コードの一覧から足す。
  for (const code of [...API_ERROR_CODES, "network", "input", "mcp_unreachable", "stream_ended"])
    keys.add(`error.${code}`);

  return keys;
}

/** 文言に埋め込む差し込みの名前。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

describe("i18n", () => {
  test("ja と en は同じキーを持つ", () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  });

  test("空の文言が無い", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim().length, `en: ${key}`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(ja)) {
      expect(value.trim().length, `ja: ${key}`).toBeGreaterThan(0);
    }
  });

  test("日本語の文言に英字だけのものは無い（訳し忘れの検出）", () => {
    for (const [key, value] of Object.entries(ja)) {
      if (key === "app.name") continue; // 固有名詞
      expect(/[ぁ-んァ-ヶ一-龯]/.test(value), `ja: ${key} = ${value}`).toBe(true);
    }
  });

  test("差し込みの名前は ja と en で揃っている", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(ja[key]), key).toEqual(placeholders(en[key]));
    }
  });

  test("差し込んだ値が文言に入る", () => {
    setLocale("en");
    expect(t("settings.mcp.tools", { count: 3 })).toBe("Tools (3)");

    setLocale("ja");
    expect(t("settings.mcp.tools", { count: 3 })).toBe("ツール（3）");
  });

  test("ja のボタンの文言は「する」で終わらない", () => {
    const keys = [
      "common.add",
      "common.edit",
      "common.check",
      "common.delete",
      "chat.env.submit",
      "settings.mcp.authorize",
      "settings.mcp.form.save",
      "settings.webSearch.form.save",
      "settings.wizard.save",
      "settings.connectors.program.connect",
      "settings.connectors.token.save",
      "settings.discord.save",
    ] as const;

    for (const key of keys) expect(ja[key], key).not.toMatch(/する$/);
  });

  test("ja に生の英単語（webhook / identity）を残さない", () => {
    for (const [key, value] of Object.entries(ja)) {
      expect(value, `ja: ${key}`).not.toContain("webhook");
      expect(value, `ja: ${key}`).not.toContain("identity");
    }
  });

  test("ja は丸括弧を全角にする", () => {
    for (const [key, value] of Object.entries(ja)) {
      expect(value, `ja: ${key}`).not.toContain(" (");
    }
  });

  test("en に「(s)」を残さない", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en: ${key}`).not.toContain("(s)");
    }
  });

  test("en の cannot は 1 語で書く", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en: ${key}`).not.toContain("can not");
    }
  });

  test("画面が参照するキーはすべて辞書にある", () => {
    const missing = [...referencedKeys()].filter((key) => !(key in en));
    expect(missing).toEqual([]);
  });

  test("辞書のキーはすべて画面から参照されている", () => {
    const referenced = referencedKeys();
    const unused = Object.keys(en).filter((key) => !referenced.has(key));
    expect(unused).toEqual([]);
  });

  test("ロケールを切り替えると文言が変わる", () => {
    setLocale("ja");
    expect(t("composer.send")).toBe("送信");

    setLocale("en");
    expect(t("composer.send")).toBe("Send");

    setLocale("ja");
  });
});

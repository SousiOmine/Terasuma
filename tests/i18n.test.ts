import { describe, expect, test } from "bun:test";
import { setLocale, t } from "../src/client/i18n";
import { en } from "../src/client/i18n/en";
import { ja } from "../src/client/i18n/ja";

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

  test("ロケールを切り替えると文言が変わる", () => {
    setLocale("ja");
    expect(t("composer.send")).toBe("送信");

    setLocale("en");
    expect(t("composer.send")).toBe("Send");

    setLocale("ja");
  });
});

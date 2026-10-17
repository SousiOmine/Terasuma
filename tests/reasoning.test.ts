import { describe, expect, test } from "bun:test";
import type { CatalogModel } from "../src/server/models-dev";
import { reasoningProviderOptions, selectableEfforts } from "../src/server/reasoning";

/** 思考強度として effort の値を持つモデル。 */
function modelWithEffort(values: string[]): CatalogModel {
  return { id: "m", contextTokens: null, reasoningOptions: [{ type: "effort", values }] };
}

/** 思考強度を持たない（toggle だけの）モデル。 */
const togglable: CatalogModel = { id: "m", contextTokens: null, reasoningOptions: [{ type: "toggle" }] };

describe("思考強度の選択肢", () => {
  test("モデルが挙げた値のうち、こちらから渡せるものだけを出す", () => {
    // OpenAI 互換のプロバイダは reasoningEffort の値をそのまま渡せる。
    expect(selectableEfforts("deepseek", modelWithEffort(["low", "high", "max"]))).toEqual(["low", "high", "max"]);
  });

  test("Anthropic は AI SDK が受ける値に絞る", () => {
    // models.dev は max も挙げるが、AI SDK の effort には無い。
    expect(selectableEfforts("anthropic", modelWithEffort(["low", "medium", "high", "max"]))).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  test("Google は thinkingLevel の値に絞る", () => {
    expect(selectableEfforts("google", modelWithEffort(["minimal", "low", "medium", "high"]))).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(selectableEfforts("google", modelWithEffort(["none", "minimal"]))).toEqual(["minimal"]);
  });

  test("思考強度を持たないモデルでは空になる", () => {
    expect(selectableEfforts("deepseek", togglable)).toEqual([]);
    expect(selectableEfforts("deepseek", null)).toEqual([]);
  });
});

describe("思考強度の受け渡し", () => {
  test("未設定なら何も渡さない", () => {
    expect(reasoningProviderOptions("deepseek", null)).toBeNull();
  });

  test("OpenAI 互換のプロバイダはプロバイダ名の下に reasoningEffort を渡す", () => {
    expect(reasoningProviderOptions("novita-ai", "high")).toEqual({ "novita-ai": { reasoningEffort: "high" } });
    expect(reasoningProviderOptions("openai", "xhigh")).toEqual({ openai: { reasoningEffort: "xhigh" } });
  });

  test("Anthropic は effort を渡す", () => {
    expect(reasoningProviderOptions("anthropic", "high")).toEqual({ anthropic: { effort: "high" } });
  });

  test("Google は thinkingConfig.thinkingLevel を渡す", () => {
    expect(reasoningProviderOptions("google", "medium")).toEqual({
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
  });

  test("渡せない値は、黙って落とさず理由を添えて止める", () => {
    expect(() => reasoningProviderOptions("anthropic", "max")).toThrow(/思考強度 max/);
    expect(() => reasoningProviderOptions("deepseek", "very-high")).toThrow(/思考強度 very-high/);
  });
});

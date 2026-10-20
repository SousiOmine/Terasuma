import { describe, expect, test } from "bun:test";
import type { CatalogModel } from "../src/server/provider/catalog";
import { catalogRoute, providerSpecForId, type ProviderSpec } from "../src/server/provider/registry";
import { reasoningProviderOptions, selectableEfforts } from "../src/server/agent/reasoning";

/** 思考強度として effort の値を持つモデル。 */
function modelWithEffort(values: string[]): CatalogModel {
  return { id: "m", contextTokens: null, reasoningOptions: [{ type: "effort", values }] };
}

/** 思考強度を持たない（toggle だけの）モデル。 */
const togglable: CatalogModel = { id: "m", contextTokens: null, reasoningOptions: [{ type: "toggle" }] };

/** カタログのプロバイダから、実際に使う spec を作る。 */
function specOf(id: string, npm: string, api: string | null = null): ProviderSpec {
  const route = catalogRoute({ id, npm, api });
  if (route === null) throw new Error(`${id} の spec を作れませんでした`);
  return route.spec;
}

const compatible = specOf("deepseek", "@ai-sdk/openai-compatible", "https://api.deepseek.com");
const anthropic = specOf("anthropic", "@ai-sdk/anthropic");
const google = specOf("google", "@ai-sdk/google");
const openai = specOf("openai", "@ai-sdk/openai");

describe("思考強度の選択肢", () => {
  test("モデルが挙げた値のうち、こちらから渡せるものだけを出す", () => {
    // OpenAI 互換のプロバイダは reasoningEffort の値をそのまま渡せる。
    expect(selectableEfforts(compatible, modelWithEffort(["low", "high", "max"]))).toEqual(["low", "high", "max"]);
  });

  test("Anthropic は AI SDK が受ける値に絞る", () => {
    expect(selectableEfforts(anthropic, modelWithEffort(["low", "medium", "high", "max"]))).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    // effort を持たない値は落とす。
    expect(selectableEfforts(anthropic, modelWithEffort(["none", "high"]))).toEqual(["high"]);
  });

  test("Google は thinkingLevel の値に絞る", () => {
    expect(selectableEfforts(google, modelWithEffort(["minimal", "low", "medium", "high"]))).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(selectableEfforts(google, modelWithEffort(["none", "minimal"]))).toEqual(["minimal"]);
  });

  test("思考強度を持たないモデルでは空になる", () => {
    expect(selectableEfforts(compatible, togglable)).toEqual([]);
    expect(selectableEfforts(compatible, null)).toEqual([]);
  });
});

describe("思考強度の受け渡し", () => {
  test("未設定なら何も渡さない", () => {
    expect(reasoningProviderOptions(compatible, null)).toBeNull();
  });

  test("OpenAI 互換のプロバイダはプロバイダ名の下に reasoningEffort を渡す", () => {
    const custom = providerSpecForId("novita-ai", null);
    expect(reasoningProviderOptions(custom, "high")).toEqual({ "novita-ai": { reasoningEffort: "high" } });
    expect(reasoningProviderOptions(openai, "xhigh")).toEqual({ openai: { reasoningEffort: "xhigh" } });
  });

  test("Anthropic は effort を渡す", () => {
    expect(reasoningProviderOptions(anthropic, "high")).toEqual({ anthropic: { effort: "high" } });
    expect(reasoningProviderOptions(anthropic, "max")).toEqual({ anthropic: { effort: "max" } });
  });

  test("Google は thinkingConfig.thinkingLevel を渡す", () => {
    expect(reasoningProviderOptions(google, "medium")).toEqual({
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
  });

  test("渡せない値は、黙って落とさず理由を添えて止める", () => {
    expect(() => reasoningProviderOptions(anthropic, "none")).toThrow(/思考強度 none/);
    expect(() => reasoningProviderOptions(compatible, "very-high")).toThrow(/思考強度 very-high/);
  });
});

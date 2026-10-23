import { describe, expect, test } from "bun:test";
import {
  chooserEntries,
  isEndpoint,
  nextCustomEndpointId,
  pickModel,
  targetOf,
} from "../../src/client/features/model/providerForm";
import type { ProviderView } from "../../src/shared/api/settings";

/**
 * プロバイダ追加ウィザードの純粋な部分。
 */

const catalogProvider = { id: "deepseek", name: "DeepSeek", models: 3 };

function providerView(overrides: Partial<ProviderView> = {}): ProviderView {
  return { id: "deepseek", name: "deepseek", baseUrl: null, hasApiKey: true, ...overrides };
}

describe("プロバイダ選択の組み立て", () => {
  test("カタログのプロバイダと雛形を、名前順に混ぜる", () => {
    const entries = chooserEntries([catalogProvider], (preset) => preset.name);

    const names = entries.map((entry) => entry.name);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect(names).toContain("DeepSeek");
    expect(names).toContain("Ollama");

    // カタログのものだけがモデル数を持つ。
    expect(entries.find((entry) => entry.id === "deepseek")?.models).toBe(3);
    expect(entries.find((entry) => entry.id === "ollama")?.models).toBeNull();
  });

  test("カタログを読めていなくても、雛形は出す", () => {
    const entries = chooserEntries(null, (preset) => preset.name);
    expect(entries.every((entry) => entry.kind === "endpoint")).toBe(true);
  });
});

describe("変更フォームの対象", () => {
  test("baseUrl が無ければカタログのプロバイダ", () => {
    expect(targetOf(providerView())).toEqual({ kind: "catalog", id: "deepseek", name: "deepseek" });
    expect(isEndpoint(providerView())).toBe(false);
  });

  test("baseUrl があれば独自エンドポイント", () => {
    const target = targetOf(providerView({ id: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }));
    expect(target.kind).toBe("endpoint");
    expect(isEndpoint(providerView({ baseUrl: "http://127.0.0.1:11434/v1" }))).toBe(true);
  });
});

describe("独自エンドポイントの id", () => {
  test("設定済みと重ならない連番を選ぶ", () => {
    expect(nextCustomEndpointId([])).toBe("custom-1");
    expect(nextCustomEndpointId([providerView({ id: "custom-1" })])).toBe("custom-2");
    expect(nextCustomEndpointId([providerView({ id: "custom-1" }), providerView({ id: "custom-2" })])).toBe("custom-3");
  });
});

describe("最初に選ぶモデル", () => {
  test("先頭を選び、無ければ選ばない", () => {
    expect(pickModel(["a", "b"])).toBe("a");
    expect(pickModel([])).toBeNull();
  });
});

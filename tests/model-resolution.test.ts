import { describe, expect, test } from "bun:test";
import type { ModelSettings } from "../src/config";
import { resolveModel, type ModelResolution } from "../src/server/engine";
import { parseCatalog, type CatalogSnapshot } from "../src/server/models-dev";

/**
 * テストで使うカタログ。npm（使うパッケージ）と api（接続先）が、
 * モデルの呼び出し方を決める材料になる。
 */
const CATALOG_RAW = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.deepseek.com",
    models: { "deepseek-flash": { id: "deepseek-flash", name: "DeepSeek Flash" } },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    api: "https://openrouter.ai/api/v1",
    models: { "anthropic/claude-sonnet-4.6": { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" } },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" } },
  },
};

const snapshot: CatalogSnapshot = parseCatalog(CATALOG_RAW, 1_000);

function settings(model: ModelSettings["model"], providers: ModelSettings["providers"] = {}): ModelSettings {
  return { model, providers, modelOptions: {} };
}

function failureOf(resolution: ModelResolution): string {
  if (resolution.ok) throw new Error("解決できてしまった");
  return resolution.detail;
}

describe("モデルの解決", () => {
  test("既定のモデルが未設定なら、そう伝える", () => {
    expect(failureOf(resolveModel(settings(null), snapshot))).toContain("既定のモデル");
  });

  test("既定のモデルのプロバイダが無ければ、その id を添えて伝える", () => {
    expect(failureOf(resolveModel(settings("deepseek/deepseek-flash"), snapshot))).toContain("deepseek");
  });

  test("カタログのプロバイダは、カタログの接続先とパッケージで呼ぶ", () => {
    const resolution = resolveModel(settings("deepseek/deepseek-flash", { deepseek: { apiKey: "sk-1" } }), snapshot);

    expect(resolution).toEqual({
      ok: true,
      model: {
        id: "deepseek/deepseek-flash",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-1",
        provider: { id: "deepseek", kind: "openai-compatible", optionKey: "deepseek" },
        reasoningEffort: null,
      },
    });
  });

  test("モデルごとの思考強度を添えて返す", () => {
    const resolution = resolveModel(
      {
        model: "deepseek/deepseek-flash",
        providers: { deepseek: { apiKey: "sk-1" } },
        modelOptions: { "deepseek/deepseek-flash": { reasoningEffort: "high" } },
      },
      snapshot,
    );

    expect(resolution.ok && resolution.model.reasoningEffort).toBe("high");
  });

  test("baseUrl があるものは独自エンドポイントとして扱う", () => {
    const resolution = resolveModel(
      settings("custom-1/qwen3-max", {
        "custom-1": { baseUrl: "https://gateway.example.test/v1", apiKey: "sk-2" },
      }),
      snapshot,
    );

    expect(resolution).toEqual({
      ok: true,
      model: {
        id: "custom-1/qwen3-max",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "sk-2",
        provider: { id: "custom-1", kind: "openai-compatible", optionKey: "custom-1" },
        reasoningEffort: null,
      },
    });
  });

  test("API キーの要らないエンドポイントはキー無しで扱う", () => {
    const resolution = resolveModel(
      settings("ollama/llama3.1", { ollama: { baseUrl: "http://127.0.0.1:11434/v1" } }),
      snapshot,
    );

    expect(resolution).toEqual({
      ok: true,
      model: {
        id: "ollama/llama3.1",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: null,
        provider: { id: "ollama", kind: "openai-compatible", optionKey: "ollama" },
        reasoningEffort: null,
      },
    });
  });

  test("プロバイダ名のあとにスラッシュが続くモデルでもプロバイダを取り違えない", () => {
    const resolution = resolveModel(
      settings("openrouter/anthropic/claude-sonnet-4.6", { openrouter: { apiKey: "sk-3" } }),
      snapshot,
    );

    if (!resolution.ok) throw new Error(resolution.detail);
    expect(resolution.model.provider).toEqual({
      id: "openrouter",
      kind: "openrouter",
      optionKey: "openrouter",
    });
    expect(resolution.model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolution.model.id).toBe("openrouter/anthropic/claude-sonnet-4.6");
  });

  test("接続先を持たないプロバイダは、パッケージの既定 URL を使う", () => {
    const resolution = resolveModel(
      settings("anthropic/claude-sonnet-4-6", { anthropic: { apiKey: "sk-4" } }),
      snapshot,
    );

    if (!resolution.ok) throw new Error(resolution.detail);
    expect(resolution.model.provider).toEqual({ id: "anthropic", kind: "anthropic", optionKey: "anthropic" });
    expect(resolution.model.baseUrl).toBeNull();
  });

  test("カタログをまだ読めていないときは、そう伝える", () => {
    const detail = failureOf(resolveModel(settings("deepseek/deepseek-flash", { deepseek: { apiKey: "sk-1" } }), null));
    expect(detail).toContain("カタログ");
  });

  test("カタログに無いプロバイダは、選び直すよう伝える", () => {
    const detail = failureOf(
      resolveModel(settings("mygateway/some-model", { mygateway: { apiKey: "sk-1" } }), snapshot),
    );
    expect(detail).toContain("mygateway");
  });

  test("既定のモデルを変えると解決結果も変わる", () => {
    const providers = { deepseek: { apiKey: "sk-1" } };
    const first = resolveModel(settings("deepseek/deepseek-flash", providers), snapshot);
    const second = resolveModel(settings("deepseek/another-model", providers), snapshot);

    expect(first.ok && first.model.id).toBe("deepseek/deepseek-flash");
    expect(second.ok && second.model.id).toBe("deepseek/another-model");
  });
});

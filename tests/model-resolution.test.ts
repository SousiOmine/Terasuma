import { describe, expect, test } from "bun:test";
import type { ModelSettings } from "../src/config";
import { resolveModel, type ModelResolution } from "../src/server/engine";

function settings(model: ModelSettings["model"], providers: ModelSettings["providers"] = {}): ModelSettings {
  return { model, providers, modelOptions: {} };
}

function failureOf(resolution: ModelResolution): string {
  if (resolution.ok) throw new Error("解決できてしまった");
  return resolution.detail;
}

describe("モデルの解決", () => {
  test("既定のモデルが未設定なら、そう伝える", () => {
    expect(failureOf(resolveModel(settings(null)))).toContain("既定のモデル");
  });

  test("既定のモデルのプロバイダが無ければ、その id を添えて伝える", () => {
    expect(failureOf(resolveModel(settings("deepseek/deepseek-flash")))).toContain("deepseek");
  });

  test("既知のプロバイダは API キーだけを渡す（URL はモデルルーターが決める）", () => {
    const resolution = resolveModel(settings("deepseek/deepseek-flash", { deepseek: { apiKey: "sk-1" } }));

    expect(resolution).toEqual({
      ok: true,
      model: { kind: "builtin", id: "deepseek/deepseek-flash", apiKey: "sk-1", reasoningEffort: null },
    });
  });

  test("モデルごとの思考強度を添えて返す", () => {
    const resolution = resolveModel({
      model: "deepseek/deepseek-flash",
      providers: { deepseek: { apiKey: "sk-1" } },
      modelOptions: { "deepseek/deepseek-flash": { reasoningEffort: "high" } },
    });

    expect(resolution.ok && resolution.model.reasoningEffort).toBe("high");
  });

  test("baseUrl があるものは独自エンドポイントとして扱う", () => {
    const resolution = resolveModel(
      settings("custom-1/qwen3-max", {
        "custom-1": { baseUrl: "https://gateway.example.test/v1", apiKey: "sk-2" },
      }),
    );

    expect(resolution).toEqual({
      ok: true,
      model: {
        kind: "endpoint",
        id: "custom-1/qwen3-max",
        url: "https://gateway.example.test/v1",
        apiKey: "sk-2",
        reasoningEffort: null,
      },
    });
  });

  test("API キーの要らないエンドポイントはキー無しで扱う", () => {
    const resolution = resolveModel(settings("ollama/llama3.1", { ollama: { baseUrl: "http://127.0.0.1:11434/v1" } }));

    expect(resolution).toEqual({
      ok: true,
      model: {
        kind: "endpoint",
        id: "ollama/llama3.1",
        url: "http://127.0.0.1:11434/v1",
        apiKey: null,
        reasoningEffort: null,
      },
    });
  });

  test("プロバイダ名のあとにスラッシュが続くモデルでもプロバイダを取り違えない", () => {
    const resolution = resolveModel(
      settings("openrouter/anthropic/claude-sonnet-4.6", { openrouter: { apiKey: "sk-3" } }),
    );

    expect(resolution.ok && resolution.model.kind === "builtin").toBe(true);
    expect(resolution.ok && resolution.model.id).toBe("openrouter/anthropic/claude-sonnet-4.6");
  });

  test("既定のモデルを変えると解決結果も変わる", () => {
    const providers = { deepseek: { apiKey: "sk-1" } };
    const first = resolveModel(settings("deepseek/deepseek-flash", providers));
    const second = resolveModel(settings("deepseek/deepseek-v4-pro", providers));

    expect(first.ok && first.model.id).toBe("deepseek/deepseek-flash");
    expect(second.ok && second.model.id).toBe("deepseek/deepseek-v4-pro");
  });
});

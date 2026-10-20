import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import {
  catalogRoute,
  createLanguageModel,
  providerSpecForId,
  toolResultTakesImages,
} from "../src/server/provider/registry";

/** 生成したモデルの、providerOptions のキーとモデル名を取り出す。 */
function modelInfo(model: LanguageModel): { provider: string; modelId: string } {
  if (typeof model === "string") throw new Error("プロバイダのモデルが返りませんでした");
  return { provider: model.provider, modelId: model.modelId };
}

describe("カタログのプロバイダの解決", () => {
  test("OpenAI 互換は、プロバイダ id を名前と接続先に使う", () => {
    expect(
      catalogRoute({ id: "deepseek", npm: "@ai-sdk/openai-compatible", api: "https://api.deepseek.com/" }),
    ).toEqual({
      spec: { id: "deepseek", kind: "openai-compatible", optionKey: "deepseek" },
      baseUrl: "https://api.deepseek.com",
    });
  });

  test("openai 本体は OpenAI パッケージで呼ぶ", () => {
    expect(catalogRoute({ id: "openai", npm: "@ai-sdk/openai", api: null })).toEqual({
      spec: { id: "openai", kind: "openai", optionKey: "openai" },
      baseUrl: null,
    });
  });

  test("OpenAI パッケージを使うゲートウェイは、OpenAI 互換として呼ぶ", () => {
    expect(catalogRoute({ id: "meta", npm: "@ai-sdk/openai", api: "https://api.meta.ai/v1" })).toEqual({
      spec: { id: "meta", kind: "openai-compatible", optionKey: "meta" },
      baseUrl: "https://api.meta.ai/v1",
    });
  });

  test("専用パッケージのプロバイダは、接続先が無ければパッケージの既定を使う", () => {
    expect(catalogRoute({ id: "anthropic", npm: "@ai-sdk/anthropic", api: null })).toEqual({
      spec: { id: "anthropic", kind: "anthropic", optionKey: "anthropic" },
      baseUrl: null,
    });
  });

  test("接続先を持つ専用パッケージは、その URL を使う", () => {
    expect(
      catalogRoute({ id: "minimax", npm: "@ai-sdk/anthropic", api: "https://api.minimax.io/anthropic/v1" }),
    ).toEqual({
      spec: { id: "minimax", kind: "anthropic", optionKey: "anthropic" },
      baseUrl: "https://api.minimax.io/anthropic/v1",
    });
  });

  test("依存に無いパッケージのプロバイダは扱わない", () => {
    expect(catalogRoute({ id: "bedrock", npm: "@ai-sdk/amazon-bedrock", api: null })).toBeNull();
  });

  test("接続先が分からない OpenAI 互換は扱わない", () => {
    expect(catalogRoute({ id: "no-api", npm: "@ai-sdk/openai-compatible", api: null })).toBeNull();
  });

  test("解決できない環境変数を含む接続先は使わない", () => {
    expect(
      catalogRoute({
        id: "cloudflare-workers-ai",
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
      }),
    ).toBeNull();
  });
});

describe("画面の思考強度のための spec", () => {
  test("カタログに無い独自エンドポイントは OpenAI 互換として扱う", () => {
    expect(providerSpecForId("custom-1", null)).toEqual({
      id: "custom-1",
      kind: "openai-compatible",
      optionKey: "custom-1",
    });
  });

  test("専用パッケージのプロバイダは、そのパッケージのキーを使う", () => {
    expect(providerSpecForId("anthropic", "@ai-sdk/anthropic")).toEqual({
      id: "anthropic",
      kind: "anthropic",
      optionKey: "anthropic",
    });
  });
});

describe("モデルの組み立て", () => {
  test("OpenAI 互換は、プロバイダ名とモデル名をそのまま使う", () => {
    const model = createLanguageModel({
      id: "deepseek/deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-1",
      provider: { id: "deepseek", kind: "openai-compatible", optionKey: "deepseek" },
      reasoningEffort: null,
    });

    const info = modelInfo(model);
    expect(info.modelId).toBe("deepseek-chat");
    // providerOptions のキーは provider 名の最初の区切りまで（deepseek.chat → deepseek）。
    expect(info.provider.split(".")[0]).toBe("deepseek");
  });

  test("専用パッケージも、モデル名だけを渡す", () => {
    const model = createLanguageModel({
      id: "anthropic/claude-sonnet-4-6",
      baseUrl: null,
      apiKey: "sk-2",
      provider: { id: "anthropic", kind: "anthropic", optionKey: "anthropic" },
      reasoningEffort: null,
    });

    const info = modelInfo(model);
    expect(info.modelId).toBe("claude-sonnet-4-6");
    expect(info.provider.split(".")[0]).toBe("anthropic");
  });

  test("OpenAI 互換で接続先が無ければ、黙って別の URL に送らない", () => {
    expect(() =>
      createLanguageModel({
        id: "no-api/some-model",
        baseUrl: null,
        apiKey: "sk-1",
        provider: { id: "no-api", kind: "openai-compatible", optionKey: "no-api" },
        reasoningEffort: null,
      }),
    ).toThrow(/接続先/);
  });
});

describe("ツール結果の画像", () => {
  test("ツールの結果に画像を置けるプロバイダを見分ける", () => {
    // content の file 部品を、そのまま画像として送れるパッケージ。
    expect(toolResultTakesImages("openai")).toBe(true);
    expect(toolResultTakesImages("anthropic")).toBe(true);
    expect(toolResultTakesImages("google")).toBe(true);
    expect(toolResultTakesImages("xai")).toBe(true);
    expect(toolResultTakesImages("openrouter")).toBe(true);
    expect(toolResultTakesImages("openai-compatible")).toBe(true);

    // 画像を JSON の文字列に潰すか、エラーにするパッケージ。
    expect(toolResultTakesImages("groq")).toBe(false);
    expect(toolResultTakesImages("mistral")).toBe(false);
    expect(toolResultTakesImages("cerebras")).toBe(false);
    expect(toolResultTakesImages("deepinfra")).toBe(false);
    expect(toolResultTakesImages("togetherai")).toBe(false);
    expect(toolResultTakesImages("perplexity")).toBe(false);
  });
});

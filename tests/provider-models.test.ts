import { describe, expect, test } from "bun:test";
import { getProviderConfig } from "@mastra/core/llm";
import { PROVIDER_CATALOG } from "../src/shared/providers";
import type { FetchLike } from "../src/server/provider-models";
import {
  createProviderModelLister,
  ProviderRequestError,
  type ProviderAccess,
} from "../src/server/provider-models";

/** 呼ばれた URL とヘッダを記録する、差し替え可能な fetch。 */
function stubFetch(handler: (url: string) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return handler(url);
  };

  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function modelsBody(ids: readonly string[]) {
  return { object: "list", data: ids.map((id) => ({ id, object: "model" })) };
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderRequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderRequestError) return error;
    throw error;
  }
  throw new Error("失敗しなかった");
}

const deepseek: ProviderAccess = { id: "deepseek", apiKey: "sk-test", baseUrl: null };
const endpoint: ProviderAccess = { id: "custom-1", apiKey: "sk-test", baseUrl: "https://gateway.example.test/v1" };

describe("プロバイダのモデル一覧", () => {
  test("独自エンドポイントは <ベース URL>/models を Bearer で叩く", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["qwen3-max", "qwen3-coder"])));
    const models = await createProviderModelLister(stub.fetch)(endpoint);

    expect(models).toEqual(["qwen3-max", "qwen3-coder"]);
    expect(stub.calls[0]?.url).toBe("https://gateway.example.test/v1/models");
    expect(stub.calls[0]?.headers["Authorization"]).toBe("Bearer sk-test");
  });

  test("API キーの要らないエンドポイントには認証ヘッダを付けない", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["llama3.1"])));
    await createProviderModelLister(stub.fetch)({ id: "ollama", apiKey: null, baseUrl: "http://127.0.0.1:11434/v1" });

    expect(stub.calls[0]?.url).toBe("http://127.0.0.1:11434/v1/models");
    expect(stub.calls[0]?.headers["Authorization"]).toBeUndefined();
  });

  test("既知のプロバイダはカタログの URL を使う", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["deepseek-v4-pro"])));
    await createProviderModelLister(stub.fetch)(deepseek);

    expect(stub.calls[0]?.url).toBe("https://api.deepseek.com/models");
    expect(stub.calls[0]?.headers["Authorization"]).toBe("Bearer sk-test");
  });

  test("Anthropic は x-api-key とバージョンのヘッダを使う", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["claude-sonnet-4-6"])));
    await createProviderModelLister(stub.fetch)({ id: "anthropic", apiKey: "sk-ant", baseUrl: null });

    expect(stub.calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(stub.calls[0]?.headers["x-api-key"]).toBe("sk-ant");
    expect(stub.calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("Google の OpenAI 互換 API は models/ の接頭辞を落とす", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["models/gemini-3.5-flash", "gemini-2.5-pro"])));
    const models = await createProviderModelLister(stub.fetch)({ id: "google", apiKey: "key", baseUrl: null });

    expect(models).toEqual(["gemini-3.5-flash", "gemini-2.5-pro"]);
  });

  test("重複した ID は 1 つにまとめる", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["a", "a", "b"])));
    expect(await createProviderModelLister(stub.fetch)(endpoint)).toEqual(["a", "b"]);
  });

  test("401 は API キーの問題として返す（本文のメッセージを添える）", async () => {
    const stub = stubFetch(() => jsonResponse({ error: { message: "Invalid API key" } }, 401));
    const failure = await failureOf(createProviderModelLister(stub.fetch)(deepseek));

    expect(failure.code).toBe("provider_auth_failed");
    expect(failure.message).toBe("Invalid API key");
  });

  test("403 も API キーの問題として返す", async () => {
    const stub = stubFetch(() => new Response("", { status: 403 }));
    expect((await failureOf(createProviderModelLister(stub.fetch)(deepseek))).code).toBe("provider_auth_failed");
  });

  test("その他の失敗は到達できないものとして返す", async () => {
    const stub = stubFetch(() => new Response("Not Found", { status: 404 }));
    const failure = await failureOf(createProviderModelLister(stub.fetch)(deepseek));

    expect(failure.code).toBe("provider_unreachable");
    expect(failure.message).toContain("HTTP 404");
  });

  test("JSON でない応答は形式の違いとして返す", async () => {
    const stub = stubFetch(() => new Response("<html></html>", { status: 200 }));
    expect((await failureOf(createProviderModelLister(stub.fetch)(endpoint))).code).toBe("provider_unreachable");
  });

  test("data 配列が無い応答は形式の違いとして返す", async () => {
    const stub = stubFetch(() => jsonResponse({ models: [] }));
    const failure = await failureOf(createProviderModelLister(stub.fetch)(endpoint));

    expect(failure.code).toBe("provider_unreachable");
    expect(failure.message).toContain("data");
  });

  test("モデルが 1 つも無ければその旨を返す", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody([])));
    expect((await failureOf(createProviderModelLister(stub.fetch)(endpoint))).code).toBe("provider_no_models");
  });

  test("接続できないときは理由を添えて返す", async () => {
    const failing: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    const failure = await failureOf(createProviderModelLister(failing)(endpoint));
    expect(failure.code).toBe("provider_unreachable");
    expect(failure.message).toContain("ECONNREFUSED");
  });
});

describe("カタログ", () => {
  test("既知のプロバイダは Mastra のモデルルーターに登録されている", () => {
    for (const entry of PROVIDER_CATALOG) {
      // 独自エンドポイントは URL を渡して呼ぶので、登録が無くてよい。
      if (entry.kind === "openai-compatible") continue;
      expect(getProviderConfig(entry.id), `未登録: ${entry.id}`).toBeDefined();
    }
  });

  test("モデル一覧の取得先は https か、ローカルの http", () => {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.kind !== "builtin") continue;
      expect(new URL(entry.modelsUrl).protocol, entry.id).toBe("https:");
    }
  });
});

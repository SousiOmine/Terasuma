import { describe, expect, test } from "bun:test";
import {
  connectionTarget,
  createConnectionChecker,
  createModelLister,
  ProviderRequestError,
  type FetchLike,
  type ProviderRequest,
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

/** カタログのプロバイダ（models.dev に api があるもの）。 */
const catalogProvider: ProviderRequest = {
  target: connectionTarget({ id: "deepseek", baseUrl: null, api: "https://api.deepseek.com" }),
  apiKey: "sk-test",
};

/** カタログのプロバイダ（api が無く、Mastra が既定の URL を使うもの）。 */
const anthropic: ProviderRequest = {
  target: connectionTarget({ id: "anthropic", baseUrl: null, api: null }),
  apiKey: "sk-ant",
};

/** 接続先を自分で決めるエンドポイント。 */
const endpoint: ProviderRequest = {
  target: connectionTarget({ id: "custom-1", baseUrl: "https://gateway.example.test/v1", api: null }),
  apiKey: "sk-test",
};

const keyless: ProviderRequest = {
  target: connectionTarget({ id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", api: null }),
  apiKey: null,
};

describe("接続確認の宛先", () => {
  test("カタログの api から /models を作る", () => {
    expect(connectionTarget({ id: "deepseek", baseUrl: null, api: "https://api.deepseek.com/" })).toEqual({
      url: "https://api.deepseek.com/models",
      auth: "bearer",
    });
  });

  test("独自エンドポイントの URL を優先する", () => {
    expect(connectionTarget({ id: "deepseek", baseUrl: "https://proxy.example.test/v1", api: "https://api.deepseek.com" })).toEqual({
      url: "https://proxy.example.test/v1/models",
      auth: "bearer",
    });
  });

  test("api が無いプロバイダは、分かっている一覧の URL を使う", () => {
    expect(connectionTarget({ id: "anthropic", baseUrl: null, api: null })).toEqual({
      url: "https://api.anthropic.com/v1/models",
      auth: "x-api-key",
      headers: { "anthropic-version": "2023-06-01" },
    });
  });

  test("宛先が分からないものは確認しない", () => {
    expect(connectionTarget({ id: "custom-1", baseUrl: null, api: null })).toBeNull();
  });
});

describe("接続確認", () => {
  test("カタログのプロバイダは api の /models を Bearer で叩く", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["deepseek-v4-pro"])));
    const result = await createConnectionChecker(stub.fetch)(catalogProvider);

    expect(result).toEqual({ verified: true, models: ["deepseek-v4-pro"] });
    expect(stub.calls[0]?.url).toBe("https://api.deepseek.com/models");
    expect(stub.calls[0]?.headers["Authorization"]).toBe("Bearer sk-test");
  });

  test("独自エンドポイントは <ベース URL>/models を叩く", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["qwen3-max", "qwen3-coder"])));
    const result = await createConnectionChecker(stub.fetch)(endpoint);

    expect(result.verified).toBe(true);
    expect(result.models).toEqual(["qwen3-max", "qwen3-coder"]);
    expect(stub.calls[0]?.url).toBe("https://gateway.example.test/v1/models");
  });

  test("API キーの要らないエンドポイントには認証ヘッダを付けない", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["llama3.1"])));
    await createConnectionChecker(stub.fetch)(keyless);

    expect(stub.calls[0]?.url).toBe("http://127.0.0.1:11434/v1/models");
    expect(stub.calls[0]?.headers["Authorization"]).toBeUndefined();
  });

  test("Anthropic は x-api-key とバージョンのヘッダを使う", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["claude-sonnet-4-6"])));
    await createConnectionChecker(stub.fetch)(anthropic);

    expect(stub.calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(stub.calls[0]?.headers["x-api-key"]).toBe("sk-ant");
    expect(stub.calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("重複した ID は 1 つにまとめる", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["a", "a", "b"])));
    const result = await createConnectionChecker(stub.fetch)(endpoint);

    expect(result.models).toEqual(["a", "b"]);
  });

  test("確認する宛先が無ければ、通信せずに確認できなかったものとして返す", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["never"])));
    const result = await createConnectionChecker(stub.fetch)({ target: null, apiKey: "sk-1" });

    expect(result).toEqual({ verified: false, models: [] });
    expect(stub.calls).toHaveLength(0);
  });

  test("一覧を公開していないプロバイダは、失敗ではなく確認できなかったものとして返す", async () => {
    for (const status of [404, 405, 501]) {
      const stub = stubFetch(() => new Response("", { status }));
      expect(await createConnectionChecker(stub.fetch)(endpoint)).toEqual({ verified: false, models: [] });
    }
  });

  test("一覧の形をしていない応答も、確認できなかったものとして返す", async () => {
    const stub = stubFetch(() => jsonResponse({ models: [] }));
    expect(await createConnectionChecker(stub.fetch)(endpoint)).toEqual({ verified: false, models: [] });
  });

  test("401 は API キーの問題として返す（本文のメッセージを添える）", async () => {
    const stub = stubFetch(() => jsonResponse({ error: { message: "Invalid API key" } }, 401));
    const failure = await failureOf(createConnectionChecker(stub.fetch)(catalogProvider));

    expect(failure.code).toBe("provider_auth_failed");
    expect(failure.message).toBe("Invalid API key");
  });

  test("403 も API キーの問題として返す", async () => {
    const stub = stubFetch(() => new Response("", { status: 403 }));
    expect((await failureOf(createConnectionChecker(stub.fetch)(catalogProvider))).code).toBe("provider_auth_failed");
  });

  test("その他の失敗は到達できないものとして返す", async () => {
    const stub = stubFetch(() => new Response("Server Error", { status: 500 }));
    const failure = await failureOf(createConnectionChecker(stub.fetch)(catalogProvider));

    expect(failure.code).toBe("provider_unreachable");
    expect(failure.message).toContain("HTTP 500");
  });

  test("接続できないときは理由を添えて返す", async () => {
    const failing: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    const failure = await failureOf(createConnectionChecker(failing)(endpoint));
    expect(failure.code).toBe("provider_unreachable");
    expect(failure.message).toContain("ECONNREFUSED");
  });
});

describe("独自エンドポイントのモデル一覧", () => {
  test("一覧を返す", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["qwen3-max"])));
    expect(await createModelLister(stub.fetch)(endpoint)).toEqual(["qwen3-max"]);
  });

  test("一覧を公開していなければ、その旨を返す", async () => {
    const stub = stubFetch(() => new Response("", { status: 404 }));
    const failure = await failureOf(createModelLister(stub.fetch)(endpoint));

    expect(failure.code).toBe("provider_no_models");
    expect(failure.message).toContain("/models");
  });

  test("モデルが 1 つも無ければその旨を返す", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody([])));
    expect((await failureOf(createModelLister(stub.fetch)(endpoint))).code).toBe("provider_no_models");
  });

  test("接続先が無ければ失敗にする", async () => {
    const stub = stubFetch(() => jsonResponse(modelsBody(["never"])));
    expect((await failureOf(createModelLister(stub.fetch)({ target: null, apiKey: null }))).code).toBe(
      "provider_unreachable",
    );
  });
});

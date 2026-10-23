import { describe, expect, test } from "bun:test";
import { WebSearchError } from "../../src/server/websearch/errors";
import { combineSignal } from "../../src/server/http/client";
import { requestJson } from "../../src/server/websearch/http";
import type { FetchLike } from "../../src/server/websearch/types";

/**
 * プロバイダ共通の通信処理。状態から失敗の種類を決めることと、
 * エラー本文から読める文言を取り出すことを確かめる。
 */

function respondWith(body: unknown, status = 200): FetchLike {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

async function rejection(promise: Promise<unknown>): Promise<WebSearchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WebSearchError) return error;
    throw error;
  }
  throw new Error("失敗するはずの呼び出しが成功しました");
}

function call(fetch: FetchLike): Promise<unknown> {
  return requestJson(
    fetch,
    "https://api.example.test",
    { method: "GET" },
    {
      timeoutMs: 1_000,
      provider: "Example",
    },
  );
}

describe("HTTP の失敗の分類", () => {
  test("401 と 403 は auth", async () => {
    expect((await rejection(call(respondWith({}, 401)))).code).toBe("auth");
    expect((await rejection(call(respondWith({}, 403)))).code).toBe("auth");
  });

  test("429 は rate_limit、402 は quota", async () => {
    expect((await rejection(call(respondWith({}, 429)))).code).toBe("rate_limit");
    expect((await rejection(call(respondWith({}, 402)))).code).toBe("quota");
  });

  test("400 番台は invalid、500 番台は unavailable", async () => {
    expect((await rejection(call(respondWith({}, 400)))).code).toBe("invalid");
    expect((await rejection(call(respondWith({}, 422)))).code).toBe("invalid");
    expect((await rejection(call(respondWith({}, 500)))).code).toBe("unavailable");
    expect((await rejection(call(respondWith({}, 503)))).code).toBe("unavailable");
  });

  test("状態は WebSearchError に残る", async () => {
    const error = await rejection(call(respondWith({}, 429)));
    expect(error.status).toBe(429);
  });
});

describe("エラー本文の読み取り", () => {
  test("error.message を優先する", async () => {
    const error = await rejection(call(respondWith({ error: { message: "bad api key" } }, 401)));
    expect(error.message).toContain("bad api key");
  });

  test("error が文字列ならそのまま使う", async () => {
    const error = await rejection(call(respondWith({ error: "quota exceeded" }, 402)));
    expect(error.message).toContain("quota exceeded");
  });

  test("detail が文字列でも読む", async () => {
    const error = await rejection(call(respondWith({ detail: "invalid query" }, 400)));
    expect(error.message).toContain("invalid query");
  });

  test("detail が配列なら msg をまとめる", async () => {
    const error = await rejection(call(respondWith({ detail: [{ msg: "first" }, { msg: "second" }] }, 422)));
    expect(error.message).toContain("first");
    expect(error.message).toContain("second");
  });

  test("JSON でない本文は、そのまま理由にする", async () => {
    const error = await rejection(call(respondWith("plain failure", 500)));
    expect(error.message).toContain("plain failure");
  });

  test("本文が無くても失敗にする", async () => {
    const error = await rejection(call(respondWith("", 500)));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("HTTP 500");
  });
});

describe("通信の失敗", () => {
  test("JSON でない成功応答は unavailable", async () => {
    const error = await rejection(call(respondWith("<html>not json</html>")));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("not JSON");
  });

  test("タイムアウトの例外は unavailable", async () => {
    const error = await rejection(
      call(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("did not respond");
  });

  test("外部からの中断は unavailable", async () => {
    const error = await rejection(
      call(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("aborted");
  });

  test("その他の例外は理由を含める", async () => {
    const error = await rejection(
      call(async () => {
        throw new TypeError("network down");
      }),
    );
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("network down");
  });
});

describe("中断の合成", () => {
  test("呼び出し元の中断が伝わる", () => {
    const controller = new AbortController();
    const signal = combineSignal(controller.signal, 60_000);
    expect(signal.aborted).toBe(false);

    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  test("中断が無くてもタイムアウトの signal を返す", () => {
    const signal = combineSignal(undefined, 60_000);
    expect(signal.aborted).toBe(false);
  });
});

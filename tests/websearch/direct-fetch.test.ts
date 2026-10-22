import { describe, expect, test } from "bun:test";
import { MAX_DIRECT_FETCH_CHARS } from "../../src/server/websearch/constants";
import { fetchDirect } from "../../src/server/websearch/direct-fetch";
import { WebSearchError } from "../../src/server/websearch/errors";
import type { FetchLike } from "../../src/server/websearch/types";

/** 直接取得は、取得 API を持たないプロバイダ（Brave / Perplexity）で使われる。 */

function respondingFetch(response: Response): FetchLike {
  return async () => response;
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

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

describe("ページの直接取得", () => {
  test("HTML はタイトルと本文に分ける", async () => {
    const response = await fetchDirect(
      respondingFetch(htmlResponse("<html><head><title>Page</title></head><body><p>Body</p></body></html>")),
      { url: "https://example.com/page" },
    );

    expect(response.url).toBe("https://example.com/page");
    expect(response.title).toBe("Page");
    expect(response.text).toBe("Body");
  });

  test("プレーンテキストはそのまま返す", async () => {
    const response = await fetchDirect(
      respondingFetch(new Response("  plain text  ", { headers: { "Content-Type": "text/plain" } })),
      { url: "https://example.com/raw" },
    );

    expect(response.title).toBeNull();
    expect(response.text).toBe("plain text");
  });

  test("Content-Type が無い応答も本文として返す", async () => {
    const response = await fetchDirect(respondingFetch(new Response("body")), { url: "https://example.com/x" });
    expect(response.text).toBe("body");
  });

  test("PDF は読めないと返す", async () => {
    const error = await rejection(
      fetchDirect(respondingFetch(new Response("%PDF", { headers: { "Content-Type": "application/pdf" } })), {
        url: "https://example.com/doc.pdf",
      }),
    );

    expect(error.code).toBe("unsupported");
  });

  test("画像など本文でない応答も unsupported", async () => {
    const error = await rejection(
      fetchDirect(respondingFetch(new Response("binary", { headers: { "Content-Type": "image/png" } })), {
        url: "https://example.com/image.png",
      }),
    );

    expect(error.code).toBe("unsupported");
  });

  test("404 は URL の誤りとして invalid", async () => {
    const error = await rejection(
      fetchDirect(respondingFetch(htmlResponse("not found", 404)), { url: "https://example.com/missing" }),
    );

    expect(error.code).toBe("invalid");
    expect(error.status).toBe(404);
  });

  test("500 は unavailable", async () => {
    const error = await rejection(
      fetchDirect(respondingFetch(htmlResponse("broken", 500)), { url: "https://example.com/broken" }),
    );

    expect(error.code).toBe("unavailable");
    expect(error.status).toBe(500);
  });

  test("http と https 以外は取得しない", async () => {
    const error = await rejection(fetchDirect(respondingFetch(htmlResponse("x")), { url: "file:///etc/passwd" }));

    expect(error.code).toBe("invalid");
    expect(error.message).toContain("http");
  });

  test("URL として読めない値は invalid", async () => {
    const error = await rejection(fetchDirect(respondingFetch(htmlResponse("x")), { url: "not a url" }));
    expect(error.code).toBe("invalid");
  });

  test("タイムアウトは unavailable", async () => {
    const error = await rejection(
      fetchDirect(
        async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
        { url: "https://example.com/slow" },
      ),
    );

    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("time");
  });

  test("Content-Length が上限を超える応答は読まない", async () => {
    const error = await rejection(
      fetchDirect(
        respondingFetch(
          new Response("x", {
            headers: { "Content-Type": "text/plain", "Content-Length": String(64 * 1024 * 1024) },
          }),
        ),
        { url: "https://example.com/huge" },
      ),
    );

    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("larger");
  });

  test("本文が文字数の上限を超えたら止める", async () => {
    const error = await rejection(
      fetchDirect(
        respondingFetch(
          new Response("x".repeat(MAX_DIRECT_FETCH_CHARS + 1), { headers: { "Content-Type": "text/plain" } }),
        ),
        { url: "https://example.com/huge" },
      ),
    );

    expect(error.code).toBe("unavailable");
  });
});

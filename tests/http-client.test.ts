import { describe, expect, test } from "bun:test";
import { errorDetailFromText, readErrorDetail, sendRequest, type FetchLike } from "../src/server/http/client";

describe("外部 HTTP の共通処理", () => {
  test("失敗の本文から、JSON の文言を取り出す", () => {
    expect(errorDetailFromText(JSON.stringify({ error: { message: "bad key" } }), 200)).toBe("bad key");
    expect(errorDetailFromText(JSON.stringify({ error: "bad key" }), 200)).toBe("bad key");
    expect(errorDetailFromText(JSON.stringify({ detail: "quota" }), 200)).toBe("quota");
    expect(errorDetailFromText(JSON.stringify({ message: "nope" }), 200)).toBe("nope");
    expect(errorDetailFromText(JSON.stringify([{ message: "a" }, { message: "b" }]), 200)).toBe("a; b");
  });

  test("JSON でない本文は 1 行に詰めて切る", () => {
    expect(errorDetailFromText("  server\n\n error  ", 200)).toBe("server error");
    expect(errorDetailFromText("x".repeat(300), 10)).toBe(`${"x".repeat(10)}…`);
    expect(errorDetailFromText("   ", 200)).toBe("");
  });

  test("応答の本文が読めなくても空文字で続ける", async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("broken"));
        },
      }),
    );

    expect(await readErrorDetail(response, 200)).toBe("");
  });

  test("通信の失敗は、投げずに結果で返す", async () => {
    const failing: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };

    const outcome = await sendRequest(failing, "https://example.test", {}, { timeoutMs: 1_000 });
    expect(outcome.kind).toBe("network");
    if (outcome.kind === "network") {
      expect(outcome.timedOut).toBe(false);
      expect((outcome.error as Error).message).toBe("ECONNREFUSED");
    }
  });

  test("時間切れは timedOut で知らせる", async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const outcome = await sendRequest(slow, "https://example.test", {}, { timeoutMs: 5 });
    expect(outcome.kind).toBe("network");
    if (outcome.kind === "network") expect(outcome.timedOut).toBe(true);
  });

  test("応答が返れば、状態コードに関係なくそのまま返す", async () => {
    const failingStatus: FetchLike = async () => new Response("no", { status: 500 });

    const outcome = await sendRequest(failingStatus, "https://example.test", {}, { timeoutMs: 1_000 });
    expect(outcome.kind).toBe("response");
    if (outcome.kind === "response") expect(outcome.response.status).toBe(500);
  });
});

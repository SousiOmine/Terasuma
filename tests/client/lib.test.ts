import { describe, expect, test } from "bun:test";
import { toErrorState, createErrorSignal } from "../../src/client/lib/errors";
import { ApiError } from "../../src/client/lib/http";
import { pollUntil } from "../../src/client/lib/polling";

/**
 * クライアントの失敗の揃え方と、待ち続ける処理。
 * どちらも DOM を使わないので、そのまま確かめられる。
 */

describe("失敗の揃え方", () => {
  test("ApiError はコードと詳細をそのまま運ぶ", () => {
    expect(toErrorState(new ApiError("provider_auth_failed", "HTTP 401"))).toEqual({
      code: "provider_auth_failed",
      detail: "HTTP 401",
    });
  });

  test("知らない例外は internal_error にまとめる", () => {
    expect(toErrorState(new Error("壊れた"))).toEqual({ code: "internal_error", detail: "壊れた" });
    expect(toErrorState("文字列")).toEqual({ code: "internal_error", detail: "文字列" });
  });

  test("失敗を入れ替えられる", () => {
    const failure = createErrorSignal();
    expect(failure.error.value).toBeNull();

    failure.show(new ApiError("network", "切れた"));
    expect(failure.error.value).toEqual({ code: "network", detail: "切れた" });

    failure.clear();
    expect(failure.error.value).toBeNull();
  });
});

describe("状態を尋ね続ける", () => {
  /** 実時間を待たずに進めるための時計と待ち。 */
  function clock() {
    let now = 0;
    return {
      now: () => now,
      delay: async (ms: number) => {
        now += ms;
      },
    };
  }

  test("終わったら、その値を返す", async () => {
    const time = clock();
    let probes = 0;

    const outcome = await pollUntil({
      intervalMs: 10,
      timeoutMs: 100,
      cancelled: () => false,
      probe: async () => {
        probes += 1;
        return probes;
      },
      done: (value) => value >= 2,
      now: time.now,
      delay: time.delay,
    });

    expect(outcome).toEqual({ kind: "value", value: 2 });
    expect(probes).toBe(2);
  });

  test("終わらなければ timeout を返す", async () => {
    const time = clock();

    const outcome = await pollUntil({
      intervalMs: 10,
      timeoutMs: 30,
      cancelled: () => false,
      probe: async () => "まだ",
      done: () => false,
      now: time.now,
      delay: time.delay,
    });

    expect(outcome).toEqual({ kind: "timeout" });
  });

  test("待つのをやめたら、尋ねに行かない", async () => {
    const time = clock();
    let probes = 0;

    const outcome = await pollUntil({
      intervalMs: 10,
      timeoutMs: 100,
      // 最初の待ちのあとで「やめた」ことになる。
      cancelled: () => time.now() >= 10,
      probe: async () => {
        probes += 1;
        return "まだ";
      },
      done: () => false,
      now: time.now,
      delay: time.delay,
    });

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(probes).toBe(0);
  });

  test("尋ねる処理の失敗は、そのまま返す", async () => {
    const time = clock();
    const failure = new Error("届かない");

    const outcome = await pollUntil({
      intervalMs: 10,
      timeoutMs: 100,
      cancelled: () => false,
      probe: async () => {
        throw failure;
      },
      done: () => false,
      now: time.now,
      delay: time.delay,
    });

    expect(outcome).toEqual({ kind: "error", error: failure });
  });
});

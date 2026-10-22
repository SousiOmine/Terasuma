import { describe, expect, test } from "bun:test";
import { createEnvRequests } from "../src/server/computer/env";
import { readSettingsFile } from "../src/server/data/settings-schema";
import { withTempSettings } from "./support";

/**
 * 環境変数の入力待ち。
 * 値は設定へ書き、ツールの戻り値（モデルへ渡る文）には含めない。
 */

/** テストで使う待ちの signal。ターンを止めたければ controller.abort() を呼ぶ。 */
function signalOf(controller = new AbortController()): AbortSignal {
  return controller.signal;
}

describe("環境変数の待ち", () => {
  test("入力された値を保存し、戻り値には値を含めない", async () => {
    await withTempSettings(null, async (store, path) => {
      const requests = createEnvRequests({ settings: store });

      const waiting = requests.wait("t1", "GITHUB_TOKEN", signalOf());
      expect(requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "ghp_secret" })).toBe(true);

      const result = await waiting;
      expect(result).toContain("GITHUB_TOKEN");
      // モデルへ返す文には、入力された値を一切含めない。
      expect(result).not.toContain("ghp_secret");

      expect(store.read().env).toEqual({ GITHUB_TOKEN: "ghp_secret" });
      expect(readSettingsFile(path).env).toEqual({ GITHUB_TOKEN: "ghp_secret" });

      // 返したあとの待ちは残らない。
      expect(requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "x" })).toBe(false);
    });
  });

  test("値の前後の空白は落として保存する", async () => {
    await withTempSettings(null, async (store) => {
      const requests = createEnvRequests({ settings: store });

      const waiting = requests.wait("t1", "GITHUB_TOKEN", signalOf());
      expect(requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "  ghp_1 \n" })).toBe(true);
      await waiting;

      expect(store.read().env).toEqual({ GITHUB_TOKEN: "ghp_1" });
    });
  });

  test("別の名前の返事は受け取らず、待ちは残る", async () => {
    await withTempSettings(null, async (store) => {
      const requests = createEnvRequests({ settings: store });

      const waiting = requests.wait("t1", "GITHUB_TOKEN", signalOf());

      // 遅れて届いた別の呼び出しの返事は、消費しない。
      expect(requests.answer("t1", { kind: "value", name: "OTHER", value: "x" })).toBe(false);
      expect(requests.answer("t1", { kind: "cancel", name: "OTHER" })).toBe(false);

      expect(requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "ghp_1" })).toBe(true);
      expect(await waiting).toContain("GITHUB_TOKEN");
    });
  });

  test("取り消されたら、何も保存せずに失敗する", async () => {
    await withTempSettings(null, async (store) => {
      const requests = createEnvRequests({ settings: store });

      const waiting = requests.wait("t1", "GITHUB_TOKEN", signalOf());
      expect(requests.answer("t1", { kind: "cancel", name: "GITHUB_TOKEN" })).toBe(true);

      expect(await waiting.catch((error: unknown) => (error as Error).message)).toContain("did not enter a value");
      expect(store.read().env).toEqual({});
      expect(requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "x" })).toBe(false);
    });
  });

  test("別の Tera の待ちは混ざらない", async () => {
    await withTempSettings(null, async (store) => {
      const requests = createEnvRequests({ settings: store });

      const first = requests.wait("t1", "FIRST_TOKEN", signalOf());
      const second = requests.wait("t2", "SECOND_TOKEN", signalOf());

      expect(requests.answer("t2", { kind: "value", name: "SECOND_TOKEN", value: "second" })).toBe(true);
      expect(await second).toContain("SECOND_TOKEN");

      expect(requests.answer("t1", { kind: "value", name: "FIRST_TOKEN", value: "first" })).toBe(true);
      expect(await first).toContain("FIRST_TOKEN");

      expect(store.read().env).toEqual({ SECOND_TOKEN: "second", FIRST_TOKEN: "first" });
    });
  });

  test("ターンが止まったら、待たずに終わる", async () => {
    await withTempSettings(null, async (store) => {
      const requests = createEnvRequests({ settings: store });
      const controller = new AbortController();

      const waiting = requests.wait("t1", "GITHUB_TOKEN", controller.signal);
      controller.abort();

      expect(await waiting.catch((error: unknown) => (error as Error).message)).toContain("The turn ended");
      // 止まったあとの返事は受け取らない。
      expect(requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "x" })).toBe(false);
    });
  });

  test("すでに止まっているターンでは、待ちを作らずに終わる", async () => {
    await withTempSettings(null, async (store) => {
      const requests = createEnvRequests({ settings: store });
      const controller = new AbortController();
      controller.abort();

      const waiting = requests.wait("t1", "GITHUB_TOKEN", controller.signal);

      expect(await waiting.catch((error: unknown) => (error as Error).message)).toContain("The turn ended");
      expect(requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "x" })).toBe(false);
    });
  });

  test("設定できない名前では、そもそも待たない", async () => {
    await withTempSettings(null, async (store) => {
      const requests = createEnvRequests({ settings: store });

      await expect(requests.wait("t1", "1BAD", signalOf())).rejects.toThrow(/not a valid environment variable name/);
      // 予約名は、コンテナの中のコマンドの動きを壊すので設定させない。
      await expect(requests.wait("t1", "PATH", signalOf())).rejects.toThrow(/used by the computer/);
    });
  });

  test("受け付けられない値では、待ちを消費しない", async () => {
    await withTempSettings(null, async (store) => {
      const requests = createEnvRequests({ settings: store });

      const waiting = requests.wait("t1", "GITHUB_TOKEN", signalOf());

      expect(() => requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "   " })).toThrow(
        /値を入力してください/,
      );
      expect(() => requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "a\u0000b" })).toThrow(/NUL/);

      // 断っただけなので、待ちは残っていて、正しい値なら通る。
      expect(requests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "ghp_1" })).toBe(true);
      expect(await waiting).toContain("GITHUB_TOKEN");
      expect(store.read().env).toEqual({ GITHUB_TOKEN: "ghp_1" });
    });
  });
});

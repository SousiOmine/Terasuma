import { describe, expect, test } from "bun:test";
import { beginHandover, endHandover, handoverActive } from "../../src/client/state/handover";

/**
 * 引き受けの状態。
 * 並んで走った別のツールの結果で、画面が操作できるままにならないことを確かめる。
 */
describe("引き受けの状態", () => {
  test("始めた呼び出しの結果でだけ、見るだけに戻る", () => {
    beginHandover("c1", "ログイン");
    expect(handoverActive.value).toBe(true);

    // 別の呼び出しの結果では、まだユーザーの操作待ちが続いている。
    endHandover("c2");
    expect(handoverActive.value).toBe(true);

    endHandover("c1");
    expect(handoverActive.value).toBe(false);
  });
});

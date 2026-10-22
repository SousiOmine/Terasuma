import { describe, expect, test } from "bun:test";
import {
  beginEnvRequest,
  endEnvRequest,
  envRequestActive,
  envRequestDescription,
  envRequestName,
  resetEnvRequest,
} from "../../src/client/state/env-request";

/**
 * 環境変数の入力欄の状態。
 * 並んで走った別のツールの結果で、入力欄が消えないことを確かめる。
 */
describe("環境変数の入力欄の状態", () => {
  test("始めた呼び出しの結果でだけ閉じる", () => {
    beginEnvRequest("c1", "GITHUB_TOKEN", "リポジトリを読むため");
    expect(envRequestActive.value).toBe(true);
    expect(envRequestName.value).toBe("GITHUB_TOKEN");
    expect(envRequestDescription.value).toBe("リポジトリを読むため");

    // 別の呼び出しの結果では、まだ入力待ちが続いている。
    endEnvRequest("c2");
    expect(envRequestActive.value).toBe(true);

    endEnvRequest("c1");
    expect(envRequestActive.value).toBe(false);
    expect(envRequestName.value).toBeNull();
    expect(envRequestDescription.value).toBeNull();
  });

  test("リセットは待ちを残さず、あとから届いた結果でも戻らない", () => {
    beginEnvRequest("c1", "TOKEN", null);
    expect(envRequestDescription.value).toBeNull();

    // ターンの停止や Tera の切り替えは、届く結果を待たずに畳む。
    resetEnvRequest();
    expect(envRequestActive.value).toBe(false);
    expect(envRequestName.value).toBeNull();

    endEnvRequest("c1");
    expect(envRequestActive.value).toBe(false);
  });
});

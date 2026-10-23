import { describe, expect, test } from "bun:test";
import {
  beginConnectionRequest,
  connectionRequest,
  endConnectionRequest,
  resetConnectionRequest,
} from "../../src/client/state/connection-request";

/**
 * 接続カードの状態。
 *
 * 始めた呼び出しの結果でだけ閉じ、失敗はカードに残す（もう一度試す導線を消さない）。
 * サーバーへの保存は画面が行うので、ここでは状態の移り方だけを確かめる。
 */
describe("接続カードの状態", () => {
  test("始めた呼び出しの結果でだけ閉じる", () => {
    beginConnectionRequest("c1", "github", "issue を読むため", null);

    expect(connectionRequest.value).toEqual({
      callId: "c1",
      provider: "github",
      reason: "issue を読むため",
      teraId: null,
      phase: "waiting",
    });

    // 別の呼び出しの結果では、まだカードを閉じない。
    endConnectionRequest("c2", false);
    expect(connectionRequest.value?.callId).toBe("c1");

    endConnectionRequest("c1", false);
    expect(connectionRequest.value).toBeNull();
  });

  test("失敗はカードに残す", () => {
    beginConnectionRequest("c3", "github", null, null);

    endConnectionRequest("c3", true);
    expect(connectionRequest.value?.phase).toBe("failed");
  });

  test("リセットは待ちを残さず、あとから届いた結果でも戻らない", () => {
    beginConnectionRequest("c5", "github", null, null);

    resetConnectionRequest();
    expect(connectionRequest.value).toBeNull();

    endConnectionRequest("c5", false);
    expect(connectionRequest.value).toBeNull();
  });

  test("理由は無くてもよい", () => {
    beginConnectionRequest("c6", "github", null, null);
    expect(connectionRequest.value?.reason).toBeNull();

    resetConnectionRequest();
  });
});

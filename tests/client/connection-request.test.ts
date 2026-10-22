import { describe, expect, test } from "bun:test";
import {
  beginConnectionRequest,
  connectionRequest,
  endConnectionRequest,
  resetConnectionRequest,
} from "../../src/client/state/connection-request";

/**
 * 認証カードの状態。
 *
 * 始めた呼び出しの結果でだけ閉じ、失敗はカードに残す（Client ID が無いときの設定への導線を消さない）。
 * サーバーへの要求は画面の effect が行うので、ここでは状態の移り方だけを確かめる。
 */
describe("認証カードの状態", () => {
  test("始めた呼び出しの結果でだけ閉じる", () => {
    beginConnectionRequest("c1", "github", "issue を読むため");

    expect(connectionRequest.value).toEqual({
      callId: "c1",
      provider: "github",
      reason: "issue を読むため",
      providerName: null,
      flow: null,
      phase: "starting",
    });

    // 別の呼び出しの結果では、まだカードを閉じない。
    endConnectionRequest("c2", false);
    expect(connectionRequest.value?.callId).toBe("c1");

    endConnectionRequest("c1", false);
    expect(connectionRequest.value).toBeNull();
  });

  test("失敗はカードに残す", () => {
    beginConnectionRequest("c3", "github", null);

    endConnectionRequest("c3", true);
    expect(connectionRequest.value?.phase).toBe("failed");
  });

  test("Client ID が無いときの案内は、結果が失敗しても残す", () => {
    beginConnectionRequest("c4", "github", null);

    const request = connectionRequest.value;
    if (request === null) throw new Error("カードが無い");
    connectionRequest.value = { ...request, phase: "setup_required" };

    endConnectionRequest("c4", true);
    expect(connectionRequest.value?.phase).toBe("setup_required");
  });

  test("リセットは待ちを残さず、あとから届いた結果でも戻らない", () => {
    beginConnectionRequest("c5", "github", null);

    resetConnectionRequest();
    expect(connectionRequest.value).toBeNull();

    endConnectionRequest("c5", false);
    expect(connectionRequest.value).toBeNull();
  });

  test("理由は無くてもよい", () => {
    beginConnectionRequest("c6", "github", null);
    expect(connectionRequest.value?.reason).toBeNull();

    resetConnectionRequest();
  });
});

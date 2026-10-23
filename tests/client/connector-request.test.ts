import { describe, expect, test } from "bun:test";
import {
  beginConnectorRequest,
  connectorRequest,
  endConnectorRequest,
  resetConnectorRequest,
} from "../../src/client/state/connector-request";

/**
 * コネクタカードの状態。
 *
 * 始めた呼び出しの結果でだけ閉じ、失敗はカードに残す（もう一度試す導線を消さない）。
 * サーバーへの保存は画面が行うので、ここでは状態の移り方だけを確かめる。
 */
describe("コネクタカードの状態", () => {
  test("始めた呼び出しの結果でだけ閉じる", () => {
    beginConnectorRequest("c1", "github", "issue を読むため", null);

    expect(connectorRequest.value).toEqual({
      callId: "c1",
      provider: "github",
      reason: "issue を読むため",
      teraId: null,
      phase: "waiting",
    });

    // 別の呼び出しの結果では、まだカードを閉じない。
    endConnectorRequest("c2", false);
    expect(connectorRequest.value?.callId).toBe("c1");

    endConnectorRequest("c1", false);
    expect(connectorRequest.value).toBeNull();
  });

  test("失敗はカードに残す", () => {
    beginConnectorRequest("c3", "github", null, null);

    endConnectorRequest("c3", true);
    expect(connectorRequest.value?.phase).toBe("failed");
  });

  test("リセットは待ちを残さず、あとから届いた結果でも戻らない", () => {
    beginConnectorRequest("c5", "github", null, null);

    resetConnectorRequest();
    expect(connectorRequest.value).toBeNull();

    endConnectorRequest("c5", false);
    expect(connectorRequest.value).toBeNull();
  });

  test("理由は無くてもよい", () => {
    beginConnectorRequest("c6", "github", null, null);
    expect(connectorRequest.value?.reason).toBeNull();

    resetConnectorRequest();
  });
});

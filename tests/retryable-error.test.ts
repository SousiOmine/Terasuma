import { describe, expect, test } from "bun:test";
import { isRetryableErrorCode } from "../src/shared/api/error";

describe("もう一度試す価値がある失敗か", () => {
  test("一時的な失敗は再試行できる", () => {
    for (const code of ["model_error", "network", "internal_error", "stream_ended"]) {
      expect(isRetryableErrorCode(code), code).toBe(true);
    }
  });

  test("設定や入力の誤りは、やり直しても変わらない", () => {
    for (const code of ["model_not_configured", "invalid_request"]) {
      expect(isRetryableErrorCode(code), code).toBe(false);
    }
  });
});

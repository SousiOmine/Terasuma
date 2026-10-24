import { describe, expect, test } from "bun:test";
import { CLIENT_HEADER } from "../src/shared/api/events";
import { withServer } from "./harness";
import { createContainerStub } from "./support";

/**
 * API 全体の守り。
 *
 * 画面の id を変更系の門にし、応答には種類の推測・Referer・別オリジンからの埋め込みを
 * 抑えるヘッダを付ける。
 */

describe("API の守り", () => {
  test("JSON の応答にセキュリティヘッダが付く", async () => {
    await withServer(async (harness) => {
      const response = await harness.request("/api/teras");

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    });
  });

  test("画面の id が無い変更系は、本文を読む前に 400", async () => {
    await withServer(
      async (harness) => {
        const response = await harness.request("/api/container/start", {
          method: "POST",
          headers: { [CLIENT_HEADER]: "" },
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
      },
      { container: createContainerStub() },
    );
  });

  test("画面の id があれば、変更系は通る", async () => {
    await withServer(
      async (harness) => {
        const response = await harness.request("/api/container/start", { method: "POST" });
        expect(response.status).toBe(200);
      },
      { container: createContainerStub() },
    );
  });
});

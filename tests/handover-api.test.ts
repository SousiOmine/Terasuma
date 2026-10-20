import { describe, expect, test } from "bun:test";
import { HANDOVER_DONE } from "../src/server/computer/handover";
import { withServer } from "./harness";

function handoverRequest(teraId: string, body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teraId, ...body }),
  };
}

describe("引き受けの API", () => {
  test("チャットの文が、待っているツールの戻り値になる", async () => {
    await withServer(async ({ request, handover }) => {
      const waiting = handover.wait("t1", new AbortController().signal);

      const response = await request(
        "/api/computer/handover",
        handoverRequest("t1", { kind: "text", text: "認証できた" }),
      );
      expect(response.status).toBe(204);
      expect(await waiting).toBe("認証できた");
    });
  });

  test("「操作を完了した」も同じ経路で返せる", async () => {
    await withServer(async ({ request, handover }) => {
      const waiting = handover.wait("t1", new AbortController().signal);

      const response = await request("/api/computer/handover", handoverRequest("t1", { kind: "done" }));
      expect(response.status).toBe(204);
      expect(await waiting).toBe(HANDOVER_DONE);
    });
  });

  test("待っていない Tera への返事は 409", async () => {
    await withServer(async ({ request }) => {
      const response = await request("/api/computer/handover", handoverRequest("t1", { kind: "done" }));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("handover_not_pending");
    });
  });

  test("壊れた入力は 400 で弾く", async () => {
    await withServer(async ({ request, handover }) => {
      // 待っている状態でも、空の文は通さない（ツールの戻り値が空になるため）。
      const waiting = handover.wait("t1", new AbortController().signal);

      const empty = await request("/api/computer/handover", handoverRequest("t1", { kind: "text", text: "   " }));
      expect(empty.status).toBe(400);

      const unknownKind = await request("/api/computer/handover", handoverRequest("t1", { kind: "whatever" }));
      expect(unknownKind.status).toBe(400);

      const noSession = await request("/api/computer/handover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "done" }),
      });
      expect(noSession.status).toBe(400);

      // どれも受け付けていないので、待ちは残ったまま。
      expect(handover.answer("t1", { kind: "done" })).toBe(true);
      expect(await waiting).toBe(HANDOVER_DONE);
    });
  });
});

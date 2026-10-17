import { describe, expect, test } from "bun:test";
import { createMockEngine } from "../src/server/engine";
import { createHandover, type Handover } from "../src/server/handover";
import { startServer } from "../src/server/server";
import { createStore } from "../src/server/store";
import { TEST_SETTINGS, createContainerStub, createMcpStub, createMemoryStub, withTempSettings } from "./support";

/** 引き受けの受け渡しを、HTTP 越しに確かめる。 */
async function withHandoverServer<T>(
  run: (harness: {
    request: (path: string, init?: RequestInit) => Promise<Response>;
    handover: Handover;
  }) => Promise<T>,
): Promise<T> {
  const handover = createHandover();

  return withTempSettings(TEST_SETTINGS, async (settings) => {
    const store = createStore(":memory:");
    const { server } = startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        configDir: ".",
        configPath: "./config.json",
        dataDir: ".",
        dbPath: ":memory:",
        engine: "mock",
        isDevelopment: false,
      },
      store,
      engine: createMockEngine({ chunkSize: 10_000, delayMs: 0 }),
      memory: createMemoryStub(store),
      settings,
      mcp: createMcpStub(),
      container: createContainerStub(),
      handover,
    });

    try {
      return await run({
        request: (path, init) => fetch(new URL(path, server.url), init),
        handover,
      });
    } finally {
      await server.stop(true);
    }
  });
}

function handoverRequest(teraId: string, body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teraId, ...body }),
  };
}

describe("引き受けの API", () => {
  test("チャットの文が、待っているツールの戻り値になる", async () => {
    await withHandoverServer(async ({ request, handover }) => {
      const waiting = handover.wait("t1", new AbortController().signal);

      const response = await request("/api/computer/handover", handoverRequest("t1", { kind: "text", text: "認証できた" }));
      expect(response.status).toBe(204);
      expect(await waiting).toBe("認証できた");
    });
  });

  test("「操作を完了した」も同じ経路で返せる", async () => {
    await withHandoverServer(async ({ request, handover }) => {
      const waiting = handover.wait("t1", new AbortController().signal);

      const response = await request("/api/computer/handover", handoverRequest("t1", { kind: "done" }));
      expect(response.status).toBe(204);
      expect(await waiting).toContain("操作を完了しました");
    });
  });

  test("待っていない Tera への返事は 409", async () => {
    await withHandoverServer(async ({ request }) => {
      const response = await request("/api/computer/handover", handoverRequest("t1", { kind: "done" }));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("handover_not_pending");
    });
  });

  test("壊れた入力は 400 で弾く", async () => {
    await withHandoverServer(async ({ request, handover }) => {
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
      expect(await waiting).toBe("ユーザーは操作を完了しました");
    });
  });
});

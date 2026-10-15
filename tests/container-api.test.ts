import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainerManager } from "../src/server/container";
import { createMockEngine } from "../src/server/engine";
import { startServer } from "../src/server/server";
import { createStore } from "../src/server/store";
import type { ContainerStatusView } from "../src/shared/types";
import { createHandover } from "../src/server/handover";
import { TEST_SETTINGS, createImageStub, createMcpStub, createPodmanStub, withTempSettings, type PodmanStubBehaviour } from "./support";

/** コンテナの API を、podman を差し替えた状態で HTTP 越しに確かめる。 */
async function withContainerServer<T>(
  behaviour: PodmanStubBehaviour,
  run: (harness: { request: (path: string, init?: RequestInit) => Promise<Response> }) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-container-api-"));
  const stub = createPodmanStub(behaviour);
  const container = createContainerManager({
    dataDir: dir,
    containerDir: join(dir, "container-files"),
    command: stub.run,
  });

  try {
    return await withTempSettings(TEST_SETTINGS, async (settings) => {
      const { server } = startServer({
        config: {
          host: "127.0.0.1",
          port: 0,
          configDir: dir,
          configPath: join(dir, "config.json"),
          dataDir: dir,
          dbPath: ":memory:",
          engine: "mock",
          isDevelopment: false,
        },
        store: createStore(":memory:"),
        engine: createMockEngine({ chunkSize: 10_000, delayMs: 0 }),
        settings,
        mcp: createMcpStub(),
        container,
        images: createImageStub(),
        handover: createHandover(),
      });

      try {
        return await run({ request: (path, init) => fetch(new URL(path, server.url), init) });
      } finally {
        await server.stop(true);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function readStatus(response: Response): Promise<ContainerStatusView> {
  expect(response.status).toBe(200);
  return (await response.json()) as ContainerStatusView;
}

describe("コンテナの API", () => {
  test("状態は podman への問い合わせの結果を返す", async () => {
    await withContainerServer({ port: "127.0.0.1:41234" }, async ({ request }) => {
      expect(await readStatus(await request("/api/container"))).toEqual({
        state: "running",
        vncPort: 41234,
        detail: null,
      });
    });
  });

  test("podman が無いことも状態として返す（エラーにはしない）", async () => {
    await withContainerServer({ podman: false }, async ({ request }) => {
      expect(await readStatus(await request("/api/container"))).toEqual({
        state: "podman_missing",
        vncPort: null,
        detail: null,
      });
      // 操作も同じ理由で失敗する（画面はコードから文言を選ぶ）。
      const started = await request("/api/container/start", { method: "POST" });
      expect(started.status).toBe(200);
      expect(((await started.json()) as ContainerStatusView).state).toBe("podman_missing");
    });
  });

  test("起動は、イメージが無ければ作るところまで行う", async () => {
    await withContainerServer({ image: false, container: false }, async ({ request }) => {
      expect(await readStatus(await request("/api/container/start", { method: "POST" }))).toMatchObject({
        state: "running",
      });
    });
  });

  test("リセットは wipeHome の指定を受け取る", async () => {
    await withContainerServer({}, async ({ request }) => {
      const kept = await request("/api/container/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wipeHome: false }),
      });
      expect(await readStatus(kept)).toMatchObject({ state: "running" });

      // body が無い場合も「ホームは消さない」として扱う。
      const withoutBody = await request("/api/container/reset", { method: "POST" });
      expect(await readStatus(withoutBody)).toMatchObject({ state: "running" });
    });
  });

  test("準備に失敗したら、理由とコードを返す", async () => {
    await withContainerServer({ image: false, fail: "build" }, async ({ request }) => {
      const response = await request("/api/container/start", { method: "POST" });
      expect(response.status).toBe(502);

      const body = (await response.json()) as { code: string; detail: string };
      expect(body.code).toBe("container_build_failed");
      expect(body.detail).toContain("ミラーに届きません");
    });
  });
});

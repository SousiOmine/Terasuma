import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createContainerManager } from "../src/server/container";
import type { ContainerStatusView } from "../src/shared/types";
import { type ServerHarness, withServer } from "./harness";
import { createPodmanStub, type PodmanStubBehaviour } from "./support";

/** コンテナの API を、podman を差し替えた状態で HTTP 越しに確かめる。 */
async function withContainerServer<T>(
  behaviour: PodmanStubBehaviour,
  run: (harness: Pick<ServerHarness, "request">) => Promise<T>,
): Promise<T> {
  const stub = createPodmanStub(behaviour);

  return withServer(({ request }) => run({ request }), {
    container: (dir) =>
      createContainerManager({
        dataDir: dir,
        containerDir: join(dir, "container-files"),
        command: stub.run,
      }),
  });
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

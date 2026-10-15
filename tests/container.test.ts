import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerError, createContainerManager } from "../src/server/container";
import { createPodmanStub, type PodmanStubBehaviour } from "./support";

/**
 * podman を差し替えて、コンテナ操作がどのコマンドを並べるかを確かめる。
 * 実際の podman は使わない（テストが端末の状態に依存しないようにするため）。
 */

/** データディレクトリごと使い捨てる。マウントするフォルダはこの下に作られる。 */
function withManager<T>(
  behaviour: PodmanStubBehaviour,
  run: (context: {
    container: ReturnType<typeof createContainerManager>;
    calls: string[][];
    dataDir: string;
    homeDir: string;
  }) => Promise<T>,
): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), "terasuma-container-"));
  const stub = createPodmanStub(behaviour);
  const container = createContainerManager({
    dataDir,
    containerDir: join(dataDir, "container-files"),
    command: stub.run,
  });

  return run({
    container,
    calls: stub.calls,
    dataDir,
    homeDir: join(dataDir, "container", "home"),
  }).finally(() => rmSync(dataDir, { recursive: true, force: true }));
}

/** 記録されたコマンドから、指定した副コマンドのものを取り出す。 */
function callsOf(calls: string[][], sub: string): string[][] {
  return calls.filter((call) => call[0] === "podman" && call[1] === sub);
}

describe("コンテナの状態", () => {
  test("podman が無ければ、そう返す", async () => {
    await withManager({ podman: false }, async ({ container, calls }) => {
      expect(await container.status()).toEqual({ state: "podman_missing", vncPort: null, detail: null });
      // 無いと分かった時点で止める（イメージやコンテナを聞きに行かない）。
      expect(callsOf(calls, "image")).toHaveLength(0);
    });
  });

  test("イメージが無ければ image_missing、コンテナが無ければ container_missing", async () => {
    await withManager({ image: false }, async ({ container }) => {
      expect(await container.status()).toEqual({ state: "image_missing", vncPort: null, detail: null });
    });

    await withManager({ container: false }, async ({ container }) => {
      expect(await container.status()).toEqual({ state: "container_missing", vncPort: null, detail: null });
    });
  });

  test("止まっていれば stopped、動いていれば running とポートを返す", async () => {
    await withManager({ running: false }, async ({ container }) => {
      expect(await container.status()).toEqual({ state: "stopped", vncPort: null, detail: null });
    });

    await withManager({ port: "127.0.0.1:40123" }, async ({ container }) => {
      expect(await container.status()).toEqual({ state: "running", vncPort: 40123, detail: null });
    });
  });

  test("ポートを読めなければ、その理由を添える", async () => {
    await withManager({ port: "not a port" }, async ({ container }) => {
      const status = await container.status();
      expect(status.state).toBe("running");
      expect(status.vncPort).toBeNull();
      expect(status.detail).not.toBeNull();
    });
  });
});

describe("コンテナの起動", () => {
  test("イメージが無ければ build してから run する", async () => {
    await withManager({ image: false }, async ({ container, calls, dataDir }) => {
      expect(await container.start()).toMatchObject({ state: "running", vncPort: 45678 });

      const build = callsOf(calls, "build");
      expect(build).toHaveLength(1);
      expect(build[0]).toEqual([
        "podman",
        "build",
        "--tag",
        "terasuma-container",
        "--file",
        join(dataDir, "container-files", "Containerfile"),
        join(dataDir, "container-files"),
      ]);

      expect(callsOf(calls, "run")).toHaveLength(1);
      expect(callsOf(calls, "start")).toHaveLength(0);
    });
  });

  test("コンテナが無ければ run し、止まっていれば start する", async () => {
    await withManager({ container: false }, async ({ container, calls }) => {
      await container.start();
      expect(callsOf(calls, "run")).toHaveLength(1);
      expect(callsOf(calls, "build")).toHaveLength(0);
    });

    await withManager({ running: false }, async ({ container, calls }) => {
      await container.start();
      expect(callsOf(calls, "start")).toHaveLength(1);
      expect(callsOf(calls, "run")).toHaveLength(0);
    });
  });

  test("動いていれば何もしない", async () => {
    await withManager({}, async ({ container, calls }) => {
      await container.start();
      expect(callsOf(calls, "run")).toHaveLength(0);
      expect(callsOf(calls, "start")).toHaveLength(0);
      expect(callsOf(calls, "build")).toHaveLength(0);
    });
  });

  test("run には userns と publish とマウントを付ける", async () => {
    await withManager({ container: false }, async ({ container, calls, homeDir }) => {
      await container.start();

      const run = callsOf(calls, "run")[0];
      if (run === undefined) throw new Error("podman run が呼ばれていない");

      expect(run).toContain("terasuma");
      expect(run).toContain("keep-id:uid=1000,gid=1000");
      expect(run).toContain(`${homeDir}:/home/agent`);
      expect(run).toContain("terasuma-container");
      expect(run.some((argument) => /^127\.0\.0\.1:\d+:6080$/.test(argument))).toBe(true);
    });
  });

  test("build が失敗したら、理由付きで止める", async () => {
    await withManager({ image: false, fail: "build" }, async ({ container }) => {
      const failure = await container.start().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ContainerError);
      expect((failure as ContainerError).code).toBe("container_build_failed");
      expect((failure as Error).message).toContain("ミラーに届きません");
    });
  });
});

describe("コンテナのリセット", () => {
  test("リセットは作り直すだけで、ホームの中身は残す", async () => {
    await withManager({}, async ({ container, calls, homeDir }) => {
      // コンテナが既にある状態では、ホームはマウント済みで中身がある。
      mkdirSync(homeDir, { recursive: true });
      writeFileSync(join(homeDir, "keep.txt"), "keep");

      expect(await container.reset({ wipeHome: false })).toMatchObject({ state: "running" });
      expect(callsOf(calls, "rm")).toHaveLength(1);
      expect(callsOf(calls, "run")).toHaveLength(1);
      // イメージは作り直さない。
      expect(callsOf(calls, "build")).toHaveLength(0);
      expect(readdirSync(homeDir)).toContain("keep.txt");
    });
  });

  test("wipeHome を選んだときだけ、ホームの中身を消す", async () => {
    await withManager({}, async ({ container, homeDir }) => {
      mkdirSync(homeDir, { recursive: true });
      writeFileSync(join(homeDir, "download.txt"), "data");
      expect(readdirSync(homeDir)).toContain("download.txt");

      await container.reset({ wipeHome: false });
      expect(readdirSync(homeDir)).toContain("download.txt");

      await container.reset({ wipeHome: true });
      expect(readdirSync(homeDir)).toHaveLength(0);
    });
  });
});

describe("コンテナの中での実行", () => {
  test("動いていれば bash -lc を実行して結果を返す", async () => {
    await withManager({ exec: { code: 0, stdout: "Linux\n", stderr: "" } }, async ({ container, calls }) => {
      const shell = await container.shell("uname -a", { timeoutMs: 1_000 });
      expect(shell).toMatchObject({ exitCode: 0, stdout: "Linux\n", stderr: "" });

      const exec = callsOf(calls, "exec")[0];
      expect(exec).toEqual([
        "podman",
        "exec",
        "--workdir",
        "/home/agent",
        "terasuma",
        "bash",
        "-lc",
        "uname -a",
      ]);
    });
  });

  test("動いていないときは、実行せずに理由を返す", async () => {
    await withManager({ running: false }, async ({ container, calls }) => {
      const failure = await container.shell("uname -a", { timeoutMs: 1_000 }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ContainerError);
      expect((failure as ContainerError).code).toBe("container_not_running");
      expect(callsOf(calls, "exec")).toHaveLength(0);
    });
  });

  test("打ち切りと切り詰めは結果に残す", async () => {
    await withManager(
      { exec: { code: -1, stdout: "長い出力", stderr: "", truncated: true, timedOut: true } },
      async ({ container }) => {
        expect(await container.shell("yes", { timeoutMs: 1_000 })).toMatchObject({
          truncated: true,
          timedOut: true,
        });
      },
    );
  });
});

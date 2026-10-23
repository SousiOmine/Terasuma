import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerError, createContainerManager } from "../src/server/computer/container";
import { createPodmanStub, testPng, type PodmanStubBehaviour } from "./support";

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
    inputs: (string | Uint8Array | undefined)[];
    dataDir: string;
    homeDir: string;
  }) => Promise<T>,
  env: () => Record<string, string> = () => ({}),
): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), "terasuma-container-"));
  const stub = createPodmanStub(behaviour);
  const container = createContainerManager({
    dataDir,
    containerDir: join(dataDir, "container-files"),
    env,
    command: stub.run,
    commandBytes: stub.runBytes,
  });

  return run({
    container,
    calls: stub.calls,
    inputs: stub.inputs,
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

  test("同じ問い合わせは短い間だけ使い回す", async () => {
    await withManager({}, async ({ container, calls }) => {
      await container.status();
      const afterFirst = callsOf(calls, "inspect").length;
      expect(afterFirst).toBeGreaterThan(0);

      // 画面の中継は 1 回の表示で何度も聞くので、2 回目以降は podman を呼ばない。
      await container.status();
      expect(callsOf(calls, "inspect")).toHaveLength(afterFirst);
    });
  });

  test("起動の後は、使い回している状態も入れ替える", async () => {
    await withManager({ running: false }, async ({ container }) => {
      expect(await container.status()).toMatchObject({ state: "stopped" });

      // 止まっている状態を読んだあとに起動しても、その後の問い合わせは running を返す。
      expect(await container.start()).toMatchObject({ state: "running" });
      expect(await container.status()).toMatchObject({ state: "running" });
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
        join(dataDir, "container-files", "desktop.Containerfile"),
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
      expect(exec).toEqual(["podman", "exec", "--workdir", "/home/agent", "terasuma", "bash", "-lc", "uname -a"]);
    });
  });

  test("設定された環境変数は、動かすコマンドへ --env で渡す", async () => {
    const variables: Record<string, string> = { GITHUB_TOKEN: "ghp_1", NO_COLOR: "1" };

    await withManager(
      {},
      async ({ container, calls }) => {
        await container.shell("printenv GITHUB_TOKEN", { timeoutMs: 1_000 });
        await container.exec(["printenv", "GITHUB_TOKEN"], { timeoutMs: 1_000 });

        const [shellCall, execCall] = callsOf(calls, "exec");
        expect(shellCall).toEqual([
          "podman",
          "exec",
          "--env",
          "GITHUB_TOKEN=ghp_1",
          "--env",
          "NO_COLOR=1",
          "--workdir",
          "/home/agent",
          "terasuma",
          "bash",
          "-lc",
          "printenv GITHUB_TOKEN",
        ]);
        expect(execCall).toEqual([
          "podman",
          "exec",
          "--env",
          "GITHUB_TOKEN=ghp_1",
          "--env",
          "NO_COLOR=1",
          "--workdir",
          "/home/agent",
          "terasuma",
          "printenv",
          "GITHUB_TOKEN",
        ]);

        // 設定は呼び出しのたびに読み直す。チャットで設定した値が、次のコマンドから効く。
        variables.GITHUB_TOKEN = "ghp_2";
        variables.NEW_TOKEN = "new";
        await container.exec(["printenv", "NEW_TOKEN"], { timeoutMs: 1_000 });

        const latest = callsOf(calls, "exec").at(-1) ?? [];
        expect(latest).toContain("GITHUB_TOKEN=ghp_2");
        expect(latest).toContain("NEW_TOKEN=new");
      },
      () => variables,
    );
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

  test("実行中のコマンドには、渡された中断の signal がそのまま届く", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "terasuma-container-"));
    const stub = createPodmanStub({});
    const seen: (AbortSignal | undefined)[] = [];
    const container = createContainerManager({
      dataDir,
      containerDir: join(dataDir, "container-files"),
      env: () => ({}),
      // 状態の問い合わせは signal を取らない。実行だけが取る。
      command: (cmd, options) => {
        seen.push(options.signal);
        return stub.run(cmd, options);
      },
    });

    try {
      const controller = new AbortController();
      await container.exec(["true"], { timeoutMs: 1_000, signal: controller.signal });
      await container.shell("uname -a", { timeoutMs: 1_000, signal: controller.signal });

      // 状態の問い合わせは signal を取らないので、実行した 2 回だけが残る。
      expect(seen.filter((signal) => signal !== undefined)).toEqual([controller.signal, controller.signal]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("ファイルは base64 で受け取り、バイト列に戻す", async () => {
    const bytes = new TextEncoder().encode("こんにちは\n");
    await withManager(
      { exec: { code: 0, stdout: Buffer.from(bytes).toString("base64"), stderr: "" } },
      async ({ container, calls }) => {
        expect(await container.readFile("/home/agent/note.txt")).toEqual(bytes);

        expect(callsOf(calls, "exec")[0]).toEqual([
          "podman",
          "exec",
          "--workdir",
          "/home/agent",
          "terasuma",
          "base64",
          "--wrap=0",
          "--",
          "/home/agent/note.txt",
        ]);
      },
    );
  });

  test("上限を超えたファイルは、途中で切らずに失敗する", async () => {
    await withManager({ exec: { code: 0, stdout: "aGVsbG8=", stderr: "", truncated: true } }, async ({ container }) => {
      await expect(container.readFile("/home/agent/huge.txt")).rejects.toThrow("larger than 16MB");
    });
  });

  test("書き込みは親ディレクトリを作り、標準入力から書く", async () => {
    const bytes = new TextEncoder().encode("こんにちは\n");
    await withManager({}, async ({ container, calls, inputs }) => {
      await container.writeFile("/home/agent/nested/note.txt", bytes);

      expect(callsOf(calls, "exec")[0]).toEqual([
        "podman",
        "exec",
        "--interactive",
        "--workdir",
        "/home/agent",
        "terasuma",
        "sh",
        "-c",
        'mkdir -p -- "$(dirname -- "$1")" && base64 --decode > "$1"',
        "sh",
        "/home/agent/nested/note.txt",
      ]);
      expect(inputs.at(-1)).toBe(Buffer.from(bytes).toString("base64"));
    });
  });

  test("ファイルが読めなければ、コンテナの理由をそのまま投げる", async () => {
    await withManager(
      { exec: { code: 1, stdout: "", stderr: "base64: /home/agent/missing.txt: No such file or directory\n" } },
      async ({ container }) => {
        await expect(container.readFile("/home/agent/missing.txt")).rejects.toThrow("No such file or directory");
      },
    );
  });
});

describe("画面の撮影", () => {
  test("PNG のバイト列をそのまま返す", async () => {
    const png = testPng(1280, 800);
    await withManager({ screenshot: png }, async ({ container, calls }) => {
      expect(await container.screenshot()).toEqual(png);

      const exec = calls.at(-1) ?? [];
      expect(exec).toContain("scrot");
      expect(exec).toContain("--pointer");
    });
  });

  test("撮れなければ、コンテナの失敗として理由を返す", async () => {
    await withManager({ fail: "screenshot" }, async ({ container }) => {
      await expect(container.screenshot()).rejects.toBeInstanceOf(ContainerError);
    });
  });
});

describe("コンテナの契約", () => {
  test("イメージの中の値がずれていたら、起動したことにせず理由を出す", async () => {
    await withManager(
      {
        running: true,
        exec: { code: 0, stdout: ":100\n1000\n1000\n/home/agent\nok", stderr: "" },
      },
      async ({ container }) => {
        await expect(container.start()).rejects.toThrow(/DISPLAY=:100/);
      },
    );
  });
});

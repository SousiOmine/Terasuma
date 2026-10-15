import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, type FileSettings } from "../src/config";
import { ContainerError, type CommandResult, type CommandRunner, type ContainerManager } from "../src/server/container";
import type { ComputerToolsetProvider } from "../src/server/engine";
import type { ImageStore } from "../src/server/images";
import type { McpManager } from "../src/server/mcp";
import { createSettingsStore, type SettingsStore } from "../src/server/settings";
import { createStore } from "../src/server/store";
import type { ContainerStatusView } from "../src/shared/types";

/** 時刻を固定したストア。updated_at の比較を決定的にするため。 */
export function makeStore() {
  let tick = 1_000;
  return createStore(":memory:", { now: () => (tick += 1) });
}

/**
 * MCP を使わないテストのための差し替え。
 * 接続も子プロセスも持たず、常に「まだ何も確かめていない」状態を返す。
 */
export function createMcpStub(): McpManager {
  const unknown = { state: "unknown", tools: [], detail: null } as const;

  return {
    status: () => unknown,
    check: async () => unknown,
    test: async () => ({ ...unknown, authorizationUrl: null }),
    toolset: async () => ({}),
    authorize: async () => ({ url: null }),
    cancelAuthorization: () => undefined,
    completeAuthorization: async () => ({ serverId: "stub" }),
    close: async () => undefined,
  };
}

/**
 * コンテナを使わないテストのための差し替え。
 * podman を呼ばず、常に「podman が無い」状態を返す。
 * vncPort を渡すと「動いている」状態になり、画面の中継のテストに使える。
 */
export function createContainerStub(options: { vncPort?: number } = {}): ContainerManager {
  const view: ContainerStatusView =
    options.vncPort === undefined
      ? { state: "podman_missing", vncPort: null, detail: null }
      : { state: "running", vncPort: options.vncPort, detail: null };

  return {
    status: async () => view,
    start: async () => view,
    stop: async () => view,
    reset: async () => view,
    shell: async () => {
      throw new ContainerError("container_not_running", "テスト用の差し替えでは実行できません");
    },
    exec: async () => {
      throw new ContainerError("container_not_running", "テスト用の差し替えでは実行できません");
    },
    screenshot: async () => {
      throw new ContainerError("container_not_running", "テスト用の差し替えでは実行できません");
    },
  };
}

/** 画像を扱わないテストのための差し替え。 */
export function createImageStub(): ImageStore {
  return {
    save: () => {
      throw new Error("テスト用の差し替えでは画像を保存できません");
    },
    read: () => null,
    find: () => null,
    cacheControl: "no-store",
  };
}

/** コンテナのツールを渡さないテストのための差し替え。 */
export function createComputerStub(): ComputerToolsetProvider {
  return { toolset: async () => ({}) };
}

/** podman を差し替えるときに決める初期状態。 */
export type PodmanStubBehaviour = {
  /** podman が入っているかどうか。 */
  podman?: boolean;
  image?: boolean;
  container?: boolean;
  running?: boolean;
  /** `podman port` が返す行。動いているときの既定は "127.0.0.1:45678"。 */
  port?: string;
  /** build / run / start / stop / rm のどれかを失敗させる。 */
  fail?: "build" | "run" | "start" | "stop" | "rm";
  /** `podman exec` の結果。 */
  exec?: { code: number; stdout: string; stderr: string; truncated?: boolean; timedOut?: boolean };
};

/**
 * podman の応答を差し替える。
 * 状態はコマンドで変わる（build すればイメージができ、stop すれば止まる）ので、
 * 呼び出し側は実際の podman と同じ順番で状態が動くことを確かめられる。
 */
export function createPodmanStub(initial: PodmanStubBehaviour = {}): {
  run: CommandRunner;
  calls: string[][];
} {
  const { podman = true, port = "127.0.0.1:45678" } = initial;
  const calls: string[][] = [];

  const state = {
    image: initial.image ?? true,
    container: initial.container ?? true,
    running: initial.running ?? true,
  };

  const result = (code: number, stdout = "", stderr = ""): CommandResult => ({
    code,
    stdout,
    stderr,
    truncated: false,
    timedOut: false,
  });

  const run: CommandRunner = async (cmd) => {
    calls.push([...cmd]);
    const [command, sub] = cmd;
    if (command !== "podman") return result(127, "", `unknown command: ${command}`);

    switch (sub) {
      case "--version":
        return podman ? result(0, "podman version 4.9.3\n") : result(127, "", "podman: command not found");

      case "image":
        return state.image ? result(0) : result(1, "", "no such image");

      case "container":
        return state.container ? result(0) : result(1, "", "no such container");

      case "inspect":
        if (!state.container) return result(125, "", "no such container");
        return result(0, state.running ? "running\n" : "exited\n");

      case "port":
        return state.running ? result(0, `${port}\n`) : result(125, "", "container is not running");

      case "build":
        if (initial.fail === "build") return result(125, "", "ミラーに届きません");
        state.image = true;
        return result(0, "Successfully tagged");

      case "run":
        if (initial.fail === "run") return result(125, "", "名前が使われています");
        state.container = true;
        state.running = true;
        return result(0, "container-id\n");

      case "start":
        if (initial.fail === "start") return result(125, "", "起動できません");
        state.running = true;
        return result(0, "terasuma\n");

      case "stop":
        if (initial.fail === "stop") return result(125, "", "止められません");
        state.running = false;
        return result(0, "terasuma\n");

      case "rm":
        if (initial.fail === "rm") return result(125, "", "消せません");
        state.container = false;
        state.running = false;
        return result(0, "terasuma\n");

      case "exec": {
        const exec = initial.exec ?? { code: 0, stdout: "", stderr: "" };
        return {
          code: exec.code,
          stdout: exec.stdout,
          stderr: exec.stderr,
          truncated: exec.truncated ?? false,
          timedOut: exec.timedOut ?? false,
        };
      }

      default:
        return result(125, "", `unhandled: ${cmd.join(" ")}`);
    }
  };

  return { run, calls };
}

/** 一時ディレクトリに本物の設定ファイルを作り、そこを指すストアを渡す。 */
export async function withTempSettings<T>(
  content: FileSettings | null,
  run: (store: SettingsStore, path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-settings-"));
  const path = join(dir, CONFIG_FILE_NAME);

  try {
    if (content !== null) writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    return await run(createSettingsStore(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 幅と高さだけを持つ最小の PNG を組み立てる。
 * 大きさの読み取りは IHDR しか見ないので、CRC などは付けない。
 */
export function testPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR チャンクの長さ
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** テストで使う設定。プロバイダ 1 件が設定済みで、既定のモデルも決まっている状態。 */
export const TEST_SETTINGS: FileSettings = {
  model: "deepseek/deepseek-flash",
  providers: { deepseek: { apiKey: "test-key" } },
};

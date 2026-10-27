import type { ContainerStatusView } from "../../shared/api/settings";
import type { CommandRunner } from "./command";
import { VNC_PORT_IN_CONTAINER } from "./contract";

/**
 * podman への問い合わせ。
 *
 * 「podman が入っているか」「イメージがあるか」「コンテナがあるか」「動いているか」
 * 「どのポートで画面を出しているか」を、コマンドの実行から切り離してここに置く。
 * 状態は Terasuma 側に台帳を持たず、毎回 podman に聞く（手で止めても食い違わない）。
 */

/** 問い合わせに許す時間。 */
export const VERSION_TIMEOUT_MS = 10_000;
export const INSPECT_TIMEOUT_MS = 30_000;

export type PodmanQuery = {
  /** podman の版。入っていなければ null。 */
  version(): Promise<string | null>;
  imageExists(): Promise<boolean>;
  containerExists(): Promise<boolean>;
  /** コンテナの状態（running / exited など）。読めなければ null。 */
  state(): Promise<string | null>;
  /** publish されている画面の中継ポート。読めなければ null。 */
  publishedVncPort(): Promise<number | null>;
  /** いまどこまで準備できているか。 */
  status(): Promise<ContainerStatusView>;
  /**
   * 動いているかだけを、podman 1 回で聞く。
   * ツールを呼ぶたびに 5 回問い合わせると、続けて使うときに待ちが積み上がる。
   */
  isRunning(): Promise<boolean>;
};

export function createPodmanQuery(options: {
  run: CommandRunner;
  containerName: string;
  imageName: string;
}): PodmanQuery {
  const { run, containerName, imageName } = options;

  async function version(): Promise<string | null> {
    const result = await run(["podman", "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    if (result.timedOut || result.code !== 0) return null;

    const text = result.stdout.trim();
    return text.length === 0 ? null : text;
  }

  async function imageExists(): Promise<boolean> {
    const result = await run(["podman", "image", "exists", imageName], { timeoutMs: INSPECT_TIMEOUT_MS });
    return result.code === 0;
  }

  async function containerExists(): Promise<boolean> {
    const result = await run(["podman", "container", "exists", containerName], { timeoutMs: INSPECT_TIMEOUT_MS });
    return result.code === 0;
  }

  async function state(): Promise<string | null> {
    const result = await run(["podman", "inspect", "--format", "{{.State.Status}}", containerName], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
    if (result.code !== 0) return null;

    const text = result.stdout.trim();
    return text.length === 0 ? null : text;
  }

  /** 実際に publish されているポートを podman から読む（Terasuma 側で覚えない）。 */
  async function publishedVncPort(): Promise<number | null> {
    const result = await run(["podman", "port", containerName, `${VNC_PORT_IN_CONTAINER}`], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
    if (result.code !== 0) return null;

    // 出力は "127.0.0.1:34567" の形。番号だけを取り出す。
    const match = /:(\d+)\s*$/.exec(result.stdout.trim());
    if (match === null) return null;

    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 ? port : null;
  }

  async function status(): Promise<ContainerStatusView> {
    if ((await version()) === null) return { state: "podman_missing", vncPort: null, detail: null };
    if (!(await imageExists())) return { state: "image_missing", vncPort: null, detail: null };
    if (!(await containerExists())) return { state: "container_missing", vncPort: null, detail: null };

    const current = await state();
    if (current !== "running") {
      return { state: "stopped", vncPort: null, detail: current === null ? "Could not read the computer status" : null };
    }

    const vncPort = await publishedVncPort();
    return {
      state: "running",
      vncPort,
      // 動いているのに中継先が読めないのは、この機能が使えない状態。黙って空の画面を出さない。
      detail: vncPort === null ? "Could not read the screen relay port from podman" : null,
    };
  }

  async function isRunning(): Promise<boolean> {
    return (await state()) === "running";
  }

  return { version, imageExists, containerExists, state, publishedVncPort, status, isRunning };
}

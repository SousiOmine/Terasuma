import { mkdirSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import type { ContainerStatusView } from "../../shared/api/settings";
import { runCommand, runCommandBytes, type CommandByteRunner, type CommandResult, type CommandRunner } from "./command";
import { podmanExec } from "./podman";
import { createPodmanQuery } from "./podman-query";
import { verifyImageContract } from "./image-contract";
import { ContainerError, type ContainerErrorCode } from "./container-error";
import {
  captureScreen,
  describeFailure,
  FILE_MAX_BASE64_CHARS,
  FILE_MAX_BYTES,
  FILE_TIMEOUT_MS,
  fileFailure,
  findFreePort,
  toShellResult,
  type ShellResult,
} from "./exec";

// ツール側は container.ts から ShellResult を読む（置き場を意識させない）。
export type { ShellResult };

// 失敗の型も、コンテナを扱う側からは container.ts で引けるようにする。
export { ContainerError, type ContainerErrorCode } from "./container-error";
import { CONTAINER_GID, CONTAINER_UID, VNC_PORT_IN_CONTAINER, WORKDIR_IN_CONTAINER } from "./contract";

/**
 * podman で動かす Debian コンテナの面倒を見る。
 *
 * エージェントのプログラムはコンテナの中に置かず、Terasuma が `podman exec` で
 * コンテナの中のコマンドを呼ぶ。画面の撮影もクリックもキー入力も、ファイルの
 * 読み書きもシェルも、この 1 本の経路に揃える。エージェントのツールはホストの
 * ファイルシステムには触れない。
 *
 * 状態は podman への問い合わせだけで決める。Terasuma 側に台帳を持つと、
 * 手でコンテナを止めたときに食い違い、どちらが本当か分からなくなる。
 */

/** コンテナとイメージの名前。設定には出さず、ここで決める（効かないつまみを増やさないため）。 */
export const CONTAINER_NAME = "terasuma";
export const IMAGE_NAME = "terasuma-container";

/**
 * エージェントが作ったスキルの置き場（コンテナ内）。
 * Agent Skills のユーザー領域の慣例（~/.agents/skills）に合わせる。
 */
export const SKILLS_DIR_IN_CONTAINER = posix.join(WORKDIR_IN_CONTAINER, ".agents", "skills");

/** データディレクトリの下で、ホストとコンテナが共有するフォルダ。 */
const HOME_DIR_NAME = join("container", "home");

/** ホスト側で、コンテナのホームに対応するディレクトリ。 */
export function containerHomeDir(dataDir: string): string {
  return join(dataDir, HOME_DIR_NAME);
}

/**
 * podman に付ける印。Terasuma が作ったコンテナだと分かるようにする。
 * 名前が変わったときや、手で作ったコンテナと見分けるために使う。
 */
const MANAGED_LABEL = "terasuma.managed=1";

const BUILD_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 60_000;

/**
 * 状態の問い合わせを使い回す時間。
 * 画面の中継は 1 回の表示で何度も同じ問い合わせをするので、毎回 podman を呼ぶと待ちが積み上がる。
 * 使う側（起動・リセット）は、操作の前後でこのキャッシュを使わない。
 */
const STATUS_CACHE_MS = 1_000;

export type ContainerManager = {
  /** podman に問い合わせて、いまどこまで準備できているかを返す。 */
  status(): Promise<ContainerStatusView>;
  /** イメージを作り、コンテナを作り、起動する（既に動いていれば何もしない）。 */
  start(): Promise<ContainerStatusView>;
  /** コンテナを作り直す。wipeHome を選ぶと、マウントしたフォルダの中身も消す。 */
  reset(options: { wipeHome: boolean }): Promise<ContainerStatusView>;
  /**
   * コンテナの中で bash -lc を実行する。動いていなければ ContainerError を投げる。
   * workdir は実行するディレクトリ。省くとコンテナのホーム（/home/agent）。
   * Tera の作業フォルダで動かすときは、存在することを確かめてから渡す。
   */
  shell(
    script: string,
    options: { timeoutMs: number; signal?: AbortSignal; maxOutputChars?: number; workdir?: string },
  ): Promise<ShellResult>;
  /**
   * コンテナの中の 1 つのコマンドを実行する。
   * シェルを介さないので、空白や記号を含む引数（打ち込む文字など）もそのまま渡せる。
   */
  exec(args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ShellResult>;
  /** コンテナの中のファイルを読む。 */
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** コンテナの中のファイルを書く。親ディレクトリが無ければ作る。 */
  writeFile(path: string, content: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** いまの画面を PNG で撮る。 */
  screenshot(signal?: AbortSignal): Promise<Uint8Array>;
};

export type ContainerManagerOptions = {
  /** ホストのデータディレクトリ。この下に、エージェントへ見せる 1 つのフォルダを作る。 */
  dataDir: string;
  /** Containerfile と entry.sh を置いているディレクトリ。 */
  containerDir: string;
  /**
   * コンテナの中のコマンドへ足す環境変数。
   * エージェントがチャットで受け取った値なので、設定が変わるたびに読み直す（呼び出しのたびに読む）。
   */
  env: () => Record<string, string>;
  /** テストで podman の呼び出しを差し替える。 */
  command?: CommandRunner;
  /** テストで、バイト列を返す呼び出し（画面の撮影）を差し替える。 */
  commandBytes?: CommandByteRunner;
};

export function createContainerManager(options: ContainerManagerOptions): ContainerManager {
  const run: CommandRunner = options.command ?? runCommand;
  const runBytes: CommandByteRunner = options.commandBytes ?? runCommandBytes;
  const homeDir = join(options.dataDir, HOME_DIR_NAME);
  const containerfilePath = join(options.containerDir, "desktop.Containerfile");

  /** podman への問い合わせ。状態は Terasuma 側に持たず、毎回ここへ聞く。 */
  const podman = createPodmanQuery({ run, containerName: CONTAINER_NAME, imageName: IMAGE_NAME });

  /** 直近に読んだ状態と、その時刻。画面の中継のように短い間に何度も聞かれるため。 */
  let cachedStatus: { at: number; view: ContainerStatusView } | null = null;

  function fail(code: ContainerErrorCode, result: CommandResult): ContainerError {
    return new ContainerError(code, describeFailure(result));
  }

  async function buildImage(): Promise<void> {
    const result = await run(
      ["podman", "build", "--tag", IMAGE_NAME, "--file", containerfilePath, options.containerDir],
      { timeoutMs: BUILD_TIMEOUT_MS },
    );
    if (result.code !== 0) throw fail("container_build_failed", result);
  }

  async function createContainer(): Promise<void> {
    // マウントする側のフォルダが無いと、podman が root の持ち物で作ってしまう。
    mkdirSync(homeDir, { recursive: true });

    const result = await run(
      [
        "podman",
        "run",
        "--detach",
        "--name",
        CONTAINER_NAME,
        "--label",
        MANAGED_LABEL,
        // コンテナの中の agent（uid 1000）をホストのユーザーへ対応させる。
        // これが無いと、マウントしたフォルダへ書き込めない。
        "--userns",
        `keep-id:uid=${CONTAINER_UID},gid=${CONTAINER_GID}`,
        "--publish",
        `127.0.0.1:${await findFreePort()}:${VNC_PORT_IN_CONTAINER}`,
        "--volume",
        `${homeDir}:${WORKDIR_IN_CONTAINER}`,
        IMAGE_NAME,
      ],
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    if (result.code !== 0) throw fail("container_start_failed", result);
  }

  async function startContainer(): Promise<void> {
    const result = await run(["podman", "start", CONTAINER_NAME], { timeoutMs: RUN_TIMEOUT_MS });
    if (result.code !== 0) throw fail("container_start_failed", result);
  }

  /** コンテナを消す。無い場合も同じ結果にしたいので、`rm --force` の失敗は見ない。 */
  async function removeContainer(): Promise<void> {
    await run(["podman", "rm", "--force", CONTAINER_NAME], { timeoutMs: REMOVE_TIMEOUT_MS });
  }

  async function status(): Promise<ContainerStatusView> {
    const at = Date.now();
    if (cachedStatus !== null && at - cachedStatus.at < STATUS_CACHE_MS) return cachedStatus.view;

    const view = await readStatus();
    cachedStatus = { at, view };
    return view;
  }

  /** podman に聞き直して、いまどこまで準備できているかを返す（使い回さない）。 */
  function readStatus(): Promise<ContainerStatusView> {
    return podman.status();
  }

  /** 動いていなければ、どの操作でも同じ理由で失敗させる。 */
  async function requireRunning(): Promise<void> {
    const current = await status();
    if (current.state !== "running") {
      throw new ContainerError(
        "container_not_running",
        `The computer is not running (state: ${current.state}). Start it from Settings > Computer.`,
      );
    }
  }

  async function start(): Promise<ContainerStatusView> {
    // 操作の前は、使い回さずに podman へ聞き直す。
    const before = await readStatus();

    switch (before.state) {
      case "podman_missing":
        return before;
      case "running":
        await verifyContract();
        return before;
      case "image_missing":
        await buildImage();
        await createContainer();
        await verifyContract();
        return refreshStatus();
      case "container_missing":
        await createContainer();
        await verifyContract();
        return refreshStatus();
      case "stopped":
        await startContainer();
        await verifyContract();
        return refreshStatus();
    }
  }

  /**
   * イメージの中の契約値（DISPLAY・uid・gid・作業ディレクトリ）を確かめる。
   * 突き合わせの中身は image-contract.ts が持つ（値の正典は contract.ts）。
   */
  async function verifyContract(): Promise<void> {
    const failure = await verifyImageContract(run, CONTAINER_NAME);
    if (failure !== null) throw new ContainerError("container_start_failed", failure.message);
  }

  /** 操作の後で状態を読み直し、使い回している分も入れ替える。 */
  async function refreshStatus(): Promise<ContainerStatusView> {
    cachedStatus = null;
    return status();
  }

  return {
    status,

    start,

    async reset({ wipeHome }) {
      await removeContainer();
      // イメージは作り直さない。作り直すのはコンテナだけ（ホームを消すかどうかは別に選ぶ）。
      if (wipeHome) rmSync(homeDir, { recursive: true, force: true });
      // 消したあとでも置き場所は要る（無いまま起動すると、podman が root の持ち物で作る）。
      mkdirSync(homeDir, { recursive: true });
      return start();
    },

    async shell(script, { timeoutMs, signal, maxOutputChars, workdir }) {
      await requireRunning();

      const result = await run(
        podmanExec({
          container: CONTAINER_NAME,
          workdir: workdir ?? WORKDIR_IN_CONTAINER,
          env: options.env(),
          command: ["bash", "-lc", script],
        }),
        {
          timeoutMs,
          signal,
          // シェルの出力は末尾を読むことが多い。表示用に詰める前まで、末尾から受け取る。
          outputFrom: "tail",
          ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
        },
      );

      return toShellResult(result);
    },

    async exec(args, { timeoutMs, signal }) {
      await requireRunning();

      const result = await run(
        podmanExec({
          container: CONTAINER_NAME,
          workdir: WORKDIR_IN_CONTAINER,
          env: options.env(),
          command: args,
        }),
        {
          timeoutMs,
          signal,
        },
      );

      return toShellResult(result);
    },

    async readFile(path, signal) {
      await requireRunning();

      // バイナリを文字列へ潰さないよう、base64 で受け取ってからバイト列に戻す。
      const result = await run(
        podmanExec({
          container: CONTAINER_NAME,
          workdir: WORKDIR_IN_CONTAINER,
          command: ["base64", "--wrap=0", "--", path],
        }),
        { timeoutMs: FILE_TIMEOUT_MS, signal, maxOutputChars: FILE_MAX_BASE64_CHARS },
      );

      const failure = fileFailure("read", path, result);
      if (failure !== null) throw failure;

      // 上限を超えた出力を途中で切ると、base64 が欠けたまま復号されて中身が壊れる。
      if (result.truncated) {
        throw new Error(
          `${path} is larger than ${FILE_MAX_BYTES / (1024 * 1024)}MB; use the bash tool to read it in parts`,
        );
      }

      return Buffer.from(result.stdout, "base64");
    },

    async writeFile(path, content, signal) {
      await requireRunning();

      // 親ディレクトリを作ってから、標準入力から書き込む。
      // パスはシェルの文字列へ埋めず、$1 として渡す。
      const result = await run(
        podmanExec({
          container: CONTAINER_NAME,
          workdir: WORKDIR_IN_CONTAINER,
          interactive: true,
          command: ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && base64 --decode > "$1"', "sh", path],
        }),
        {
          timeoutMs: FILE_TIMEOUT_MS,
          signal,
          stdin: Buffer.from(content).toString("base64"),
        },
      );

      const failure = fileFailure("write", path, result);
      if (failure !== null) throw failure;
    },

    async screenshot(signal) {
      await requireRunning();
      return captureScreen(runBytes, CONTAINER_NAME, signal);
    },
  };
}


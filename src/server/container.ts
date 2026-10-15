import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ContainerStatusView } from "../shared/types";

/**
 * podman で動かす Debian コンテナの面倒を見る。
 *
 * エージェントのプログラムはコンテナの中に置かず、Terasuma が `podman exec` で
 * コンテナの中のコマンドを呼ぶ。画面の撮影もクリックもキー入力もシェルも、
 * この 1 本の経路に揃える。
 *
 * 状態は podman への問い合わせだけで決める。Terasuma 側に台帳を持つと、
 * 手でコンテナを止めたときに食い違い、どちらが本当か分からなくなる。
 */

/** コンテナとイメージの名前。設定には出さず、ここで決める（効かないつまみを増やさないため）。 */
export const CONTAINER_NAME = "terasuma";
export const IMAGE_NAME = "terasuma-container";

/** エージェントが作業する場所。ホストのデータディレクトリの下がマウントされる。 */
export const WORKDIR_IN_CONTAINER = "/home/agent";

/** データディレクトリの下で、ホストとコンテナが共有するフォルダ。 */
const HOME_DIR_NAME = join("container", "home");

/** コンテナの中で noVNC が待ち受けているポート。 */
const VNC_PORT_IN_CONTAINER = 6080;

/** podman に付ける印。Terasuma が作ったコンテナだと分かるようにする。 */
const MANAGED_LABEL = "terasuma.managed=1";

/**
 * コンテナの中の uid / gid。Containerfile が作る agent ユーザーに合わせる。
 * keep-id でホストのユーザーへ対応させないと、マウントしたフォルダに書き込めない。
 */
const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;

/** 1 回の呼び出しで受け取る出力の上限（文字数）。超えた分は捨てて、切ったことを結果に書く。 */
const OUTPUT_LIMIT = 20_000;

const VERSION_TIMEOUT_MS = 10_000;
const INSPECT_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 60_000;

/** コンテナを操作できなかった理由。画面の文言はクライアント側の i18n が決める。 */
export type ContainerErrorCode =
  | "container_unavailable"
  | "container_build_failed"
  | "container_start_failed"
  | "container_not_running";

export class ContainerError extends Error {
  constructor(
    readonly code: ContainerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContainerError";
  }
}

/** コマンド 1 回分の結果。 */
export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** 出力の上限を超えて切られたかどうか。 */
  truncated: boolean;
  /** 待ち時間の上限で打ち切ったかどうか。 */
  timedOut: boolean;
};

/**
 * コマンドの実行。テストでは podman の代わりにこれを差し替える。
 * 実行ファイルが見つからない場合も例外にせず、code -1 の結果として返す。
 */
export type CommandRunner = (cmd: readonly string[], timeoutMs: number) => Promise<CommandResult>;

/** コンテナの中でコマンドを実行した結果。 */
export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

/** コンテナの中で 1 つのコマンドを実行した結果。 */
export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

export type ContainerManager = {
  /** podman に問い合わせて、いまどこまで準備できているかを返す。 */
  status(): Promise<ContainerStatusView>;
  /** イメージを作り、コンテナを作り、起動する（既に動いていれば何もしない）。 */
  start(): Promise<ContainerStatusView>;
  /** コンテナを作り直す。wipeHome を選ぶと、マウントしたフォルダの中身も消す。 */
  reset(options: { wipeHome: boolean }): Promise<ContainerStatusView>;
  /** コンテナの中で bash -lc を実行する。動いていなければ ContainerError を投げる。 */
  shell(script: string, options: { timeoutMs: number }): Promise<ShellResult>;
  /**
   * コンテナの中で 1 つのコマンドを実行する。
   * シェルを介さないので、空白や記号を含む引数（打ち込む文字など）もそのまま渡せる。
   */
  exec(args: readonly string[], options: { timeoutMs: number }): Promise<ExecResult>;
  /** いまの画面を PNG で撮る。 */
  screenshot(): Promise<Uint8Array>;
};

export type ContainerManagerOptions = {
  /** ホストのデータディレクトリ。この下に、エージェントへ見せる 1 つのフォルダを作る。 */
  dataDir: string;
  /** Containerfile と entry.sh を置いているディレクトリ。 */
  containerDir: string;
  /** テストで podman の呼び出しを差し替える。 */
  command?: CommandRunner;
};

export function createContainerManager(options: ContainerManagerOptions): ContainerManager {
  const run = options.command ?? runCommand;
  const homeDir = join(options.dataDir, HOME_DIR_NAME);
  const containerfilePath = join(options.containerDir, "Containerfile");

  function fail(code: ContainerErrorCode, result: CommandResult): ContainerError {
    return new ContainerError(code, describeFailure(result));
  }

  async function podmanVersion(): Promise<string | null> {
    const result = await run(["podman", "--version"], VERSION_TIMEOUT_MS);
    if (result.timedOut || result.code !== 0) return null;

    const version = result.stdout.trim();
    return version.length === 0 ? null : version;
  }

  async function imageExists(): Promise<boolean> {
    const result = await run(["podman", "image", "exists", IMAGE_NAME], INSPECT_TIMEOUT_MS);
    return result.code === 0;
  }

  async function containerExists(): Promise<boolean> {
    const result = await run(["podman", "container", "exists", CONTAINER_NAME], INSPECT_TIMEOUT_MS);
    return result.code === 0;
  }

  async function containerStatus(): Promise<string | null> {
    const result = await run(
      ["podman", "inspect", "--format", "{{.State.Status}}", CONTAINER_NAME],
      INSPECT_TIMEOUT_MS,
    );
    if (result.code !== 0) return null;

    const state = result.stdout.trim();
    return state.length === 0 ? null : state;
  }

  /** 実際に publish されているポートを podman から読む（Terasuma 側で覚えない）。 */
  async function publishedVncPort(): Promise<number | null> {
    const result = await run(
      ["podman", "port", CONTAINER_NAME, `${VNC_PORT_IN_CONTAINER}`],
      INSPECT_TIMEOUT_MS,
    );
    if (result.code !== 0) return null;

    // 出力は "127.0.0.1:34567" の形。番号だけを取り出す。
    const match = /:(\d+)\s*$/.exec(result.stdout.trim());
    if (match === null) return null;

    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 ? port : null;
  }

  async function buildImage(): Promise<void> {
    const result = await run(
      ["podman", "build", "--tag", IMAGE_NAME, "--file", containerfilePath, options.containerDir],
      BUILD_TIMEOUT_MS,
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
      RUN_TIMEOUT_MS,
    );
    if (result.code !== 0) throw fail("container_start_failed", result);
  }

  async function startContainer(): Promise<void> {
    const result = await run(["podman", "start", CONTAINER_NAME], RUN_TIMEOUT_MS);
    if (result.code !== 0) throw fail("container_start_failed", result);
  }

  /** コンテナを消す。無い場合も同じ結果にしたいので、`rm --force` の失敗は見ない。 */
  async function removeContainer(): Promise<void> {
    await run(["podman", "rm", "--force", CONTAINER_NAME], REMOVE_TIMEOUT_MS);
  }

  async function status(): Promise<ContainerStatusView> {
    if ((await podmanVersion()) === null) {
      return { state: "podman_missing", vncPort: null, detail: null };
    }
    if (!(await imageExists())) {
      return { state: "image_missing", vncPort: null, detail: null };
    }
    if (!(await containerExists())) {
      return { state: "container_missing", vncPort: null, detail: null };
    }

    const state = await containerStatus();
    if (state !== "running") {
      return { state: "stopped", vncPort: null, detail: state === null ? "コンピュータの状態を読めませんでした" : null };
    }

    const vncPort = await publishedVncPort();
    return {
      state: "running",
      vncPort,
      // 動いているのに中継先が読めないのは、この機能が使えない状態。黙って空の画面を出さない。
      detail: vncPort === null ? "画面の中継に使うポートを podman から読めませんでした" : null,
    };
  }

  async function start(): Promise<ContainerStatusView> {
    const before = await status();

    switch (before.state) {
      case "podman_missing":
      case "running":
        return before;
      case "image_missing":
        await buildImage();
        await createContainer();
        return status();
      case "container_missing":
        await createContainer();
        return status();
      case "stopped":
        await startContainer();
        return status();
    }
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

    async shell(script, { timeoutMs }) {
      const current = await status();
      if (current.state !== "running") {
        throw new ContainerError(
          "container_not_running",
          `コンピュータが動いていません（いまの状態: ${current.state}）。設定の「コンピュータ」から起動してください`,
        );
      }

      const result = await run(
        ["podman", "exec", "--workdir", WORKDIR_IN_CONTAINER, CONTAINER_NAME, "bash", "-lc", script],
        timeoutMs,
      );

      return {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };
    },

    async exec(args, { timeoutMs }) {
      const current = await status();
      if (current.state !== "running") {
        throw new ContainerError(
          "container_not_running",
          `コンピュータが動いていません（いまの状態: ${current.state}）。設定の「コンピュータ」から起動してください`,
        );
      }

      const result = await run(
        ["podman", "exec", "--workdir", WORKDIR_IN_CONTAINER, CONTAINER_NAME, ...args],
        timeoutMs,
      );

      return {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };
    },

    async screenshot() {
      const current = await status();
      if (current.state !== "running") {
        throw new ContainerError(
          "container_not_running",
          `コンピュータが動いていません（いまの状態: ${current.state}）。設定の「コンピュータ」から起動してください`,
        );
      }

      return captureScreen();
    },
  };
}

/**
 * 画面を PNG で撮る。画像は文字列にせず、バイト列のまま受け取る。
 * DISPLAY はイメージの ENV で入っているので、ここでは渡さなくてよい。
 */
async function captureScreen(): Promise<Uint8Array> {
  const proc = Bun.spawn({
    cmd: ["podman", "exec", CONTAINER_NAME, "import", "-window", "root", "png:-"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [data, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new ContainerError(
      "container_not_running",
      stderr.trim() || `画面を撮れませんでした（podman exec の終了コード ${code}）`,
    );
  }
  if (data.byteLength === 0) {
    throw new ContainerError("container_not_running", "画面の画像が空でした");
  }

  return new Uint8Array(data);
}

/** podman のコマンドを実行し、出力と終了コードを返す。 */
async function runCommand(cmd: readonly string[], timeoutMs: number): Promise<CommandResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const proc = Bun.spawn({
      cmd: [...cmd],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });

    const [stdout, stderr] = await Promise.all([readLimited(proc.stdout), readLimited(proc.stderr)]);
    const code = await proc.exited;

    return {
      code,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut: controller.signal.aborted,
    };
  } catch (error) {
    // podman が入っていない場合、実行ファイルが見つからずここへ来る。
    return { code: -1, stdout: "", stderr: describe(error), truncated: false, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ストリームを上限まで読み、超えた分は捨てる。
 * 上限を決めずに読むと、暴走したコマンドの出力でこちらのメモリが埋まる。
 */
async function readLimited(stream: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let text = "";
  let truncated = false;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (truncated) continue;

    const piece = decoder.decode(chunk.value, { stream: true });
    const room = OUTPUT_LIMIT - text.length;
    if (piece.length <= room) {
      text += piece;
      continue;
    }

    text += piece.slice(0, room);
    truncated = true;
  }

  text += decoder.decode();
  return { text, truncated };
}

/** publish に使う空きポートを 1 つ選ぶ。実際に使われた値は podman から読み直す。 */
async function findFreePort(): Promise<number> {
  const server = createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : null;
    if (port === null) throw new Error("空いているポートを選べませんでした");
    return port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 失敗した理由を、そのまま画面とモデルに見せられる文字列にする。 */
function describeFailure(result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `podman が終了コード ${result.code} で失敗しました`;
  return result.timedOut ? `${detail}（時間内に終わりませんでした）` : detail;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ContainerStatusView } from "../../shared/types";
import { describeError } from "../../shared/errors";
import { AppError } from "../errors";
import { runCommand, type CommandResult, type CommandRunner } from "./command";

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

const VERSION_TIMEOUT_MS = 10_000;
const INSPECT_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 60_000;
/** 画面の撮影に許す時間。podman が返らないままターンが終わらなくなるのを防ぐ。 */
const SCREENSHOT_TIMEOUT_MS = 15_000;
/** ファイルの読み書きに許す時間。 */
const FILE_TIMEOUT_MS = 60_000;
/**
 * 1 回の readFile で受け取るファイルの上限。
 * これを超えるファイルは、bash ツールで head / sed / awk を使って部分を読む。
 */
const FILE_MAX_BYTES = 16 * 1024 * 1024;
/** FILE_MAX_BYTES を base64 にしたときの文字数（末尾の改行の分も足す）。 */
const FILE_MAX_BASE64_CHARS = Math.ceil(FILE_MAX_BYTES / 3) * 4 + 4;

/**
 * 状態の問い合わせを使い回す時間。
 * 画面の中継は 1 回の表示で何度も同じ問い合わせをするので、毎回 podman を呼ぶと待ちが積み上がる。
 * 使う側（起動・リセット）は、操作の前後でこのキャッシュを使わない。
 */
const STATUS_CACHE_MS = 1_000;

/** コンテナを操作できなかった理由。画面の文言はクライアント側の i18n が決める。 */
export type ContainerErrorCode = "container_build_failed" | "container_start_failed" | "container_not_running";

export class ContainerError extends AppError {
  constructor(
    override readonly code: ContainerErrorCode,
    message: string,
  ) {
    // 操作の前提（動いていること）が満たされていない場合だけ 409。
    // イメージの作成や起動の失敗は、接続先（podman）側の問題として 502 にする。
    super(code, code === "container_not_running" ? 409 : 502, message);
  }
}

/** コンテナの中でコマンドを実行した結果。 */
export type ShellResult = {
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
  shell(
    script: string,
    options: { timeoutMs: number; signal?: AbortSignal; maxOutputChars?: number },
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
};

export function createContainerManager(options: ContainerManagerOptions): ContainerManager {
  const run: CommandRunner = options.command ?? runCommand;
  const homeDir = join(options.dataDir, HOME_DIR_NAME);
  const containerfilePath = join(options.containerDir, "desktop.Containerfile");

  /** 直近に読んだ状態と、その時刻。画面の中継のように短い間に何度も聞かれるため。 */
  let cachedStatus: { at: number; view: ContainerStatusView } | null = null;

  /**
   * podman exec へ渡す --env の並び。設定されている分だけ付ける。
   * 値はシェルを介さず 1 つの引数として渡すので、空白や記号もそのまま届く。
   */
  function envArgs(): string[] {
    return Object.entries(options.env()).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  }

  function fail(code: ContainerErrorCode, result: CommandResult): ContainerError {
    return new ContainerError(code, describeFailure(result));
  }

  async function podmanVersion(): Promise<string | null> {
    const result = await run(["podman", "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    if (result.timedOut || result.code !== 0) return null;

    const version = result.stdout.trim();
    return version.length === 0 ? null : version;
  }

  async function imageExists(): Promise<boolean> {
    const result = await run(["podman", "image", "exists", IMAGE_NAME], { timeoutMs: INSPECT_TIMEOUT_MS });
    return result.code === 0;
  }

  async function containerExists(): Promise<boolean> {
    const result = await run(["podman", "container", "exists", CONTAINER_NAME], { timeoutMs: INSPECT_TIMEOUT_MS });
    return result.code === 0;
  }

  async function containerStatus(): Promise<string | null> {
    const result = await run(["podman", "inspect", "--format", "{{.State.Status}}", CONTAINER_NAME], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
    if (result.code !== 0) return null;

    const state = result.stdout.trim();
    return state.length === 0 ? null : state;
  }

  /** 実際に publish されているポートを podman から読む（Terasuma 側で覚えない）。 */
  async function publishedVncPort(): Promise<number | null> {
    const result = await run(["podman", "port", CONTAINER_NAME, `${VNC_PORT_IN_CONTAINER}`], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
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
  async function readStatus(): Promise<ContainerStatusView> {
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
      return { state: "stopped", vncPort: null, detail: state === null ? "Could not read the computer status" : null };
    }

    const vncPort = await publishedVncPort();
    return {
      state: "running",
      vncPort,
      // 動いているのに中継先が読めないのは、この機能が使えない状態。黙って空の画面を出さない。
      detail: vncPort === null ? "Could not read the screen relay port from podman" : null,
    };
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
      case "running":
        return before;
      case "image_missing":
        await buildImage();
        await createContainer();
        return refreshStatus();
      case "container_missing":
        await createContainer();
        return refreshStatus();
      case "stopped":
        await startContainer();
        return refreshStatus();
    }
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

    async shell(script, { timeoutMs, signal, maxOutputChars }) {
      await requireRunning();

      const result = await run(
        ["podman", "exec", ...envArgs(), "--workdir", WORKDIR_IN_CONTAINER, CONTAINER_NAME, "bash", "-lc", script],
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
        ["podman", "exec", ...envArgs(), "--workdir", WORKDIR_IN_CONTAINER, CONTAINER_NAME, ...args],
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
        ["podman", "exec", "--workdir", WORKDIR_IN_CONTAINER, CONTAINER_NAME, "base64", "--wrap=0", "--", path],
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
        [
          "podman",
          "exec",
          "--interactive",
          "--workdir",
          WORKDIR_IN_CONTAINER,
          CONTAINER_NAME,
          "sh",
          "-c",
          'mkdir -p -- "$(dirname -- "$1")" && base64 --decode > "$1"',
          "sh",
          path,
        ],
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
      return captureScreen(signal);
    },
  };
}

/** コマンドの結果を、ツールへ返す形に整える。 */
function toShellResult(result: CommandResult): ShellResult {
  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
  };
}

/** ファイル操作の失敗を、そのままモデルへ見せられる理由にする。成功なら null。 */
function fileFailure(action: "read" | "write", path: string, result: CommandResult): Error | null {
  if (result.timedOut) {
    return new Error(
      `Could not ${action} ${path}: the container did not respond within ${FILE_TIMEOUT_MS / 1000} seconds`,
    );
  }
  if (result.code !== 0) {
    return new Error(result.stderr.trim() || `Could not ${action} ${path} (podman exec exit code ${result.code})`);
  }
  return null;
}

/**
 * 画面を PNG で撮る。画像は文字列にせず、バイト列のまま受け取る。
 * DISPLAY はイメージの ENV で入っているので、ここでは渡さなくてよい。
 */
async function captureScreen(signal?: AbortSignal): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS);
  const abort = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  const proc = Bun.spawn({
    cmd: ["podman", "exec", CONTAINER_NAME, "import", "-window", "root", "png:-"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: abort,
  });

  try {
    const [data, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (code !== 0) {
      throw new ContainerError(
        "container_not_running",
        stderr.trim() || `Could not take a screenshot (podman exec exit code ${code})`,
      );
    }
    if (data.byteLength === 0) {
      throw new ContainerError("container_not_running", "The screenshot was empty");
    }

    return new Uint8Array(data);
  } catch (error) {
    if (error instanceof ContainerError) throw error;

    // 打ち切り（時間切れ、またはターンの停止）でもここへ来る。
    throw new ContainerError(
      "container_not_running",
      timeout.aborted
        ? `Taking a screenshot took more than ${SCREENSHOT_TIMEOUT_MS / 1000} seconds`
        : `Could not take a screenshot: ${describeError(error)}`,
    );
  }
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
    if (port === null) throw new Error("Could not find a free port");
    return port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 失敗した理由を、そのまま画面とモデルに見せられる文字列にする。 */
function describeFailure(result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `podman failed with exit code ${result.code}`;
  return result.timedOut ? `${detail} (did not finish in time)` : detail;
}

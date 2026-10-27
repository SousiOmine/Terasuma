import { createServer } from "node:net";
import { ContainerError } from "./container-error";
import { podmanExec } from "./podman";
import { WORKDIR_IN_CONTAINER } from "./contract";
import type { CommandByteRunner, CommandResult } from "./command";

/**
 * コンテナの中のコマンドを走らせ、結果をモデルや画面へ返せる形に整える。
 *
 * podman exec の引数組み立て、出力の詰め方、失敗の言い換え、画面の撮影をここにまとめる。
 * どのツールもこの 1 本の経路を通るので、ホストのファイルには触れない。
 */

/** ファイルの読み書きに許す時間。 */
export const FILE_TIMEOUT_MS = 60_000;
/** 1 回の readFile で受け取るファイルの上限。 */
export const FILE_MAX_BYTES = 16 * 1024 * 1024;
/** FILE_MAX_BYTES を base64 にしたときの文字数（末尾の改行の分も足す）。 */
export const FILE_MAX_BASE64_CHARS = Math.ceil(FILE_MAX_BYTES / 3) * 4 + 4;
/** 画面の撮影に許す時間。 */
const SCREENSHOT_TIMEOUT_MS = 15_000;
/** 画面の PNG として受け取る上限。 */
const SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;

/** コマンドの結果を、ツールへ返す形に整える。 */
export function toShellResult(result: CommandResult): ShellResult {
  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
  };
}

/** ファイル操作の失敗を、そのままモデルへ見せられる理由にする。成功なら null。 */
export function fileFailure(action: "read" | "write", path: string, result: CommandResult): Error | null {
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
 *
 * X のカーソルは root ウィンドウの画素に含まれない（X サーバーが別に描く）ので、
 * import で撮るとカーソルの無い画像になる。エージェントはポインタの位置も形も
 * 確かめられなくなるため、XFixes でカーソルを重ねる scrot を使う。
 */
export async function captureScreen(
  runBytes: CommandByteRunner,
  containerName: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const result = await runBytes(
    podmanExec({
      container: containerName,
      workdir: WORKDIR_IN_CONTAINER,
      // scrot は既存のファイルを避けて別名に書くので、/dev/stdout へ出すには --overwrite が要る。
      command: ["scrot", "--pointer", "--overwrite", "--silent", "/dev/stdout"],
    }),
    { timeoutMs: SCREENSHOT_TIMEOUT_MS, signal, maxOutputBytes: SCREENSHOT_MAX_BYTES },
  );

  if (result.timedOut) {
    throw new ContainerError(
      "container_not_running",
      `Taking a screenshot took more than ${SCREENSHOT_TIMEOUT_MS / 1000} seconds`,
    );
  }
  if (result.code !== 0) {
    throw new ContainerError(
      "container_not_running",
      result.stderr.trim() || `Could not take a screenshot (podman exec exit code ${result.code})`,
    );
  }
  if (result.stdout.byteLength === 0) {
    throw new ContainerError("container_not_running", "The screenshot was empty");
  }
  if (result.truncated) {
    throw new Error(`The screenshot is larger than ${SCREENSHOT_MAX_BYTES / (1024 * 1024)}MB`);
  }

  return result.stdout;
}

/** publish に使う空きポートを 1 つ選ぶ。実際に使われた値は podman から読み直す。 */
export async function findFreePort(): Promise<number> {
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
export function describeFailure(result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `podman failed with exit code ${result.code}`;
  return result.timedOut ? `${detail} (did not finish in time)` : detail;
}

/** ツールへ返すシェルの結果。 */
export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

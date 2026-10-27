import { podmanExec } from "./podman";
import { CONTAINER_DISPLAY, CONTAINER_GID, CONTAINER_UID, WORKDIR_IN_CONTAINER } from "./contract";
import type { CommandRunner } from "./command";

/**
 * コンテナのイメージとの約束を確かめる。
 *
 * DISPLAY・uid・gid・作業ディレクトリ・VNC のポートは、コンテナのイメージ（Containerfile と
 * entry.sh）と Terasuma の両方が知っている値。イメージを作り直したときに片方だけ変わると、
 * 画面が出ない・ファイルが読めないといった、原因の分かりにくい不調になる。
 * 起動したことにする前に、実際に動いているコンテナへ聞いて突き合わせる。
 *
 * 値そのものの正典は contract.ts。
 */

/** 契約を確かめるコマンドに許す時間。 */
const CONTRACT_TIMEOUT_MS = 30_000;

export type ContractFailure = { message: string };

/**
 * イメージの中の契約値を確かめる。食い違っていれば、理由を返す。
 * `run` はホストの podman を呼ぶ口（コンテナの中のコマンドを 1 回だけ走らせる）。
 */
export async function verifyImageContract(run: CommandRunner, containerName: string): Promise<ContractFailure | null> {
  const result = await run(
    podmanExec({
      container: containerName,
      workdir: WORKDIR_IN_CONTAINER,
      command: [
        "sh",
        "-c",
        'printf "%s\\n" "$DISPLAY"; id -u; id -g; pwd; test -d "$1" && echo ok',
        "sh",
        WORKDIR_IN_CONTAINER,
      ],
    }),
    { timeoutMs: CONTRACT_TIMEOUT_MS },
  );

  if (result.code !== 0) {
    return {
      message: `コンテナの契約を確かめられませんでした: ${result.stderr.trim() || `exit code ${result.code}`}`,
    };
  }

  const [display, uid, gid, workdir, dirOk] = result.stdout.trim().split("\n");
  const problems: string[] = [];
  if (display !== CONTAINER_DISPLAY) problems.push(`DISPLAY=${display ?? "(none)"}`);
  if (uid !== String(CONTAINER_UID)) problems.push(`uid=${uid ?? "(none)"}`);
  if (gid !== String(CONTAINER_GID)) problems.push(`gid=${gid ?? "(none)"}`);
  if (workdir !== WORKDIR_IN_CONTAINER) problems.push(`workdir=${workdir ?? "(none)"}`);
  if (dirOk !== "ok") problems.push(`${WORKDIR_IN_CONTAINER} がありません`);

  if (problems.length === 0) return null;
  return {
    message: `コンテナの契約がイメージと食い違っています（${problems.join(", ")}）。イメージを作り直してください`,
  };
}

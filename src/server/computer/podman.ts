/**
 * `podman exec` の引数を組み立てる。
 *
 * コンテナの中のコマンドは、シェル・exec・ファイルの読み書き・画面の撮影の 4 経路から呼ばれる。
 * 環境変数・作業ディレクトリ・標準入力の開き方をそれぞれで書くと、片方だけ抜ける。
 * ここで 1 度だけ組み立て、何を付けるかは呼び出し側が明示する。
 */

export type PodmanExecInput = {
  container: string;
  /** 実行するディレクトリ。 */
  workdir: string;
  /** コンテナへ渡す環境変数。空なら付けない。 */
  env?: Record<string, string>;
  /** 標準入力を開く（標準入力から書き込むとき）。 */
  interactive?: boolean;
  /** コンテナの中で実行するコマンド。 */
  command: readonly string[];
};

export function podmanExec(input: PodmanExecInput): string[] {
  return [
    "podman",
    "exec",
    ...(input.interactive === true ? ["--interactive"] : []),
    ...envArgs(input.env ?? {}),
    "--workdir",
    input.workdir,
    input.container,
    ...input.command,
  ];
}

/** 環境変数を、podman の --env の並びにする。値はシェルを介さない 1 つの引数として渡る。 */
function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

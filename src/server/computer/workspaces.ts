import { mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import { containerHomeDir } from "./container";
import { WORKDIR_IN_CONTAINER } from "./contract";

/**
 * Tera ごとの作業フォルダ。
 *
 * コンテナ（仮想マシン）の中に、Tera ごとに 1 つ置く。read / write / edit の相対パスと
 * bash の作業ディレクトリは、このフォルダを基準にする（エージェントは自分の作業場で動く）。
 * 絶対パスは制限しないので、ほかの Tera のフォルダにも、これまでどおり触れられる。
 * 作業場は境界ではなく、既定の居場所として扱う。
 *
 * 置き場はコンテナのホームの直下（/home/agent/teras/<tera id>）にする。
 * ホームはホストのデータディレクトリにマウントされているので、コンテナを作り直しても残る。
 */

/** 作業フォルダを並べるディレクトリの名前。 */
const TERAS_DIR_NAME = "teras";

/** コンテナの中の、作業フォルダを並べるディレクトリ。 */
export const TERAS_DIR_IN_CONTAINER = posix.join(WORKDIR_IN_CONTAINER, TERAS_DIR_NAME);

/**
 * Tera の id を、フォルダ名としてそのまま使えるかどうかの規則。
 * 形は shared/ids.ts の ID_PATTERN と同じだが、Tera の id はパスを組み立てるこの場所で決める。
 * 作る導線（tera_create ツール）も、行を書く前にここで確かめる。
 */
const TERA_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Tera の id を、フォルダ名としてそのまま使えるかどうか。 */
export function isTeraId(value: string): boolean {
  return TERA_ID_PATTERN.test(value);
}

/** フォルダ名に使えない id は、黙って別名にせず止める。 */
function assertTeraId(teraId: string): void {
  if (!isTeraId(teraId)) {
    throw new Error(`Tera id "${teraId}" cannot be used as a workspace folder name`);
  }
}

/** コンテナの中の、その Tera の作業フォルダ。 */
export function teraWorkspaceInContainer(teraId: string): string {
  assertTeraId(teraId);
  return posix.join(TERAS_DIR_IN_CONTAINER, teraId);
}

/** ホスト側で、その Tera の作業フォルダに対応するディレクトリ。 */
export function teraWorkspaceDir(dataDir: string, teraId: string): string {
  assertTeraId(teraId);
  return join(containerHomeDir(dataDir), TERAS_DIR_NAME, teraId);
}

/**
 * 作業フォルダを作り、コンテナの中のパスを返す。
 *
 * podman exec の --workdir は、無いフォルダを指定すると失敗する。bash を使う前に
 * 必ず通す（何度呼んでも同じ結果になる）。コンテナが止まっていても作れるよう、
 * ホスト側のパスを直接作る。Tera の作成時にも、行列を書く前にここを通す。
 */
export function ensureTeraWorkspace(dataDir: string, teraId: string): string {
  mkdirSync(teraWorkspaceDir(dataDir, teraId), { recursive: true });
  return teraWorkspaceInContainer(teraId);
}

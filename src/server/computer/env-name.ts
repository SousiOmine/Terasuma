/**
 * 環境変数のうち、ツールから設定させない名前。
 *
 * 名前そのものの規則は shared/env.ts が持つ（画面の入力と、設定ファイルの検証で同じものを使う）。
 *
 */

/**
 * エージェントのツールからは設定させない名前。
 *
 * podman exec に --env で渡すと、コンテナの中のコマンドの動き（PATH の解決や
 * ログインシェルの読み込み）が変わり、コンピュータが動かなくなる。
 * 設定ファイルに手で書く場合は、利用者の明示的な選択として止めない。
 */
export const RESERVED_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "DISPLAY",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "IFS",
];

/** ツールから設定できない名前かどうか。 */
export function isReservedEnvName(value: string): boolean {
  return RESERVED_ENV_NAMES.includes(value);
}

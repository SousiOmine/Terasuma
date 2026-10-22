/**
 * 環境変数の名前の規則。
 *
 * コンピュータ（デスクトップコンテナ）のコマンドへ渡す変数の名前は、
 * 設定ファイルに手で書いた場合と、エージェントのツールが名乗った場合の両方から来る。
 * 規則を 2 か所に書くと片方だけ直して食い違うので、ここに 1 つだけ置く。
 */

/** 環境変数名として使える形。シェルがそのまま読める名前に揃える。 */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/** 環境変数名として使えるかどうか（予約名かどうかは見ない）。 */
export function isEnvName(value: string): boolean {
  return ENV_NAME_PATTERN.test(value);
}

/** ツールから設定できない名前かどうか。 */
export function isReservedEnvName(value: string): boolean {
  return RESERVED_ENV_NAMES.includes(value);
}

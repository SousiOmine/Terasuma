/**
 * 環境変数の名前の規則。
 *
 * コンピュータ（デスクトップコンテナ）のコマンドへ渡す変数の名前は、設定ファイルに手で書いた場合と、
 * エージェントのツールが名乗った場合と、画面の入力欄に入れた場合の 3 つから来る。
 * 規則を各所に書くと片方だけ直して食い違うので、ここに 1 つだけ置く。
 */

/** 環境変数名として使える形。シェルがそのまま読める名前に揃える。 */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 環境変数名として使えるかどうか。 */
export function isEnvName(value: string): boolean {
  return ENV_NAME_PATTERN.test(value);
}

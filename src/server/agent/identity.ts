import type { TeraIdentity } from "../data/store";

/**
 * Tera の identity（自分の役割と、必要な知識）。
 *
 * identity は system プロンプトに常に載るので、短く保つ。
 * 書き換えは system プロンプトをすぐには変えない。載っているのは前回の圧縮で確定した版
 * （applied）だけで、書いた本文（content）は次に要約が書き換わったときに切り替わる
 * （compaction.ts）。ターンの途中や次のターンで先頭が変わると、プロンプトキャッシュが外れるため。
 */

/** identity の長さの上限（文字数）。system プロンプトに常に載るので、短く保つ。 */
export const MAX_IDENTITY_CHARS = 4_000;

/** identity の読み書き。Store がそのまま満たす。 */
export type IdentityStore = {
  readIdentity(teraId: string): TeraIdentity;
  writeIdentity(teraId: string, content: string): TeraIdentity;
};

/**
 * 書く前に本文を整え、長さを確かめる。
 * 空文字は「identity を消す」として受け付ける。
 */
export function normalizeIdentity(content: string): string {
  const text = content.trim();
  if (text.length > MAX_IDENTITY_CHARS) {
    throw new Error(
      `Your identity must be at most ${MAX_IDENTITY_CHARS} characters (got ${text.length}). Shorten it and try again.`,
    );
  }
  return text;
}

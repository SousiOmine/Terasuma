import { z } from "zod";

/** 「理由」の引数の型。ツールの inputSchema と、execute の引数の型で同じものを使う。 */
export type ReasonInput = { reason: string };

/**
 * ツールの定義で繰り返す小さな部品。
 *
 * ツールは 1 つずつ別のファイルにあるが、「ターンの中断を受け取る引数」「ユーザーに理由を書かせる引数」
 * 「待ちがターンの終了で打ち切られたときの文」は、どれも同じ形で同じ文言になる。
 * 各ファイルに書き写すと、直すときに取りこぼす。
 */

/** AI SDK がツールの実行に渡す、ターンの中断の口。 */
export type ToolContext = { abortSignal?: AbortSignal };

/**
 * ターンの中断の口を取り出す。待つツールは、中断できないと待ち続けてしまうので、
 * 無ければその場で失敗させる（黙って待たない）。
 */
export function requireSignal(context: ToolContext): AbortSignal {
  if (context.abortSignal === undefined) {
    throw new Error("Cannot wait for the user because the turn's abort signal is not available");
  }
  return context.abortSignal;
}

/**
 * 「なぜ必要か」をユーザーへ読ませる引数。
 * 接続や画面の引き受けのように、利用者の操作を待つツールが持つ。
 */
export const reasonSchema = z.string().min(1).describe("Why you need it, written for the user to read");

/** 理由だけを受け取るツールの引数。 */
export const reasonInputSchema = z.object({ reason: reasonSchema });

/** 待ちがターンの終了で打ち切られたときの文。ツールの戻り値（モデルの文脈）に載る。 */
export function waitEndedText(what: string): string {
  return `The turn ended before ${what}`;
}

/** 環境変数名として渡せる形（シェルがそのまま読める名前に揃える）。 */
export const ENV_NAME_ARGUMENT =
  "Use letters, digits and underscores, starting with a letter or underscore";

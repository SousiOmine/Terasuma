import type { ChatMessage, MessageRole } from "../shared/types";

/**
 * モデルへ渡す system プロンプト。
 *
 * プロンプトキャッシュは、リクエストの先頭が前回と一致するほど当たる。
 * ここには絶対に可変値を入れない。日時・ユーザー名・件数・ファイル一覧などを混ぜると、
 * 先頭が一致しなくなり、毎回キャッシュが当たらなくなる。
 * 可変の情報をモデルへ渡したくなったら、履歴の末尾（最後の user メッセージの後ろ）に置くこと。
 */
export const SYSTEM_PROMPT = [
  "You are Terasuma, a general-purpose assistant running on the user's own machine.",
  "Answer directly and concisely.",
  "Always reply in the language the user writes in.",
].join("\n");

export type ModelInputMessage = {
  role: MessageRole | "system";
  content: string;
};

/**
 * モデルへ実際に渡る入力の仕様。
 *
 * Mastra の Agent には instructions（= SYSTEM_PROMPT）を渡しているので、プロバイダが受け取る
 * メッセージ列は「system 1 件 + 保存済み履歴そのまま」になる。ここはそのあるべき形を 1 箇所で
 * 表現したもので、キャッシュ保護の回帰テスト（tests/prompt-cache.test.ts）が参照する。
 *
 * 履歴を要約・言い換え・並べ替えしないこと。キャッシュを当て続けるには、末尾への追記だけにする。
 */
export function buildModelInput(history: readonly ChatMessage[]): ModelInputMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

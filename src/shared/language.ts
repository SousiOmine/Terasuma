/**
 * エージェントの返事に使う言語。
 *
 * 画面の言語設定（i18n の locale）と同じ値を使い、送信のたびにサーバーへ渡す。
 * サーバーの system プロンプトへは入れず、ユーザープロンプトの末尾に指示として足す。
 * system プロンプトは固定のままにして、プロンプトキャッシュの先頭を変えないため。
 */
export const REPLY_LANGUAGES = ["ja", "en"] as const;

export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];

export function isReplyLanguage(value: unknown): value is ReplyLanguage {
  return typeof value === "string" && (REPLY_LANGUAGES as readonly string[]).includes(value);
}

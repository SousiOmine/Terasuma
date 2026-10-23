import type { WebSearchErrorCode } from "./errors";

/**
 * 検索の失敗を、読み手に合わせた 1 文にする。
 *
 * モデルへは英語で次の手を、画面へは日本語で理由を伝える。
 * 種類ごとの文言を 1 つの表に並べ、種類を足したときに片方だけ書き忘れないようにする
 * （Record<WebSearchErrorCode, ...> なので、追加すると型検査で止まる）。
 */
export const WEB_SEARCH_FAILURE_TEXT: Record<
  WebSearchErrorCode,
  {
    /** モデルへ返す文。provider は表示名（"Exa" など）。 */
    en(provider: string, message: string): string;
    /** 画面へ返す文。 */
    ja(message: string): string;
  }
> = {
  auth: {
    en: (provider, message) =>
      `The ${provider} API key was rejected. Ask the user to check it in Settings. (${message})`,
    ja: (message) => `API キーが受け付けられませんでした（${message}）`,
  },
  rate_limit: {
    en: (provider, message) => `The ${provider} search provider is rate limited. Try again later. (${message})`,
    ja: (message) => `レート制限に達しました（${message}）`,
  },
  quota: {
    en: (provider, message) => `The ${provider} search provider has no remaining quota. (${message})`,
    ja: (message) => `利用枠が不足しています（${message}）`,
  },
  invalid: {
    en: (provider, message) => `The ${provider} search provider rejected the request: ${message}`,
    ja: (message) => `リクエストが受け付けられませんでした（${message}）`,
  },
  unsupported: {
    en: (provider, message) => `The ${provider} search provider cannot handle this request: ${message}`,
    ja: (message) => `このプロバイダでは扱えません（${message}）`,
  },
  unavailable: {
    en: (provider, message) => `Could not reach the ${provider} search provider: ${message}`,
    ja: (message) => `接続できませんでした（${message}）`,
  },
};

/**
 * API の応答に付けるセキュリティヘッダ。
 *
 * Terasuma は loopback だけで待ち受け、認証を持たない。ブラウザから見たときの
 * 誤解（種類の推測・Referer の持ち出し・別オリジンからの埋め込み）を減らす。
 * HTML 自体は Bun が配るので、ここは API・SSE・画像・ファイルの応答に付ける。
 */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

/**
 * 本文に書かれた URL をリンクにしてよいかの判定。
 *
 * 本文はモデルが書いたものだが、`javascript:` のような URL をそのままリンクにすると、
 * 押した利用者の画面で任意のコードが動く。ここを通った URL だけをリンクにする。
 *
 * 受け付けるのは http / https / mailto と、このアプリ内の絶対パス（/api/...）だけ。
 * プロトコル相対（//example.com）は、このアプリのスキームで外へ出るので受け付けない。
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0 || url.startsWith("//")) return null;
  if (/^(?:https?:\/\/|mailto:)/i.test(url) || url.startsWith("/")) return url;
  return null;
}

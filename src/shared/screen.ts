/** 画面の WebSocket を開くためのトークンを返す API のパス。 */
export const SCREEN_TOKEN_PATH = "/api/computer/vnc-token";

/** 画面の WebSocket でトークンを載せる subprotocol の接頭辞。 */
export const SCREEN_TOKEN_PROTOCOL_PREFIX = "terasuma.vnc.";

/** トークンを、そのまま subprotocol の値にする。 */
export function screenTokenProtocol(token: string): string {
  return `${SCREEN_TOKEN_PROTOCOL_PREFIX}${token}`;
}

/** Sec-WebSocket-Protocol の値（カンマ区切り）からトークンを取り出す。無ければ null。 */
export function screenTokenFromProtocols(header: string | null): string | null {
  if (header === null) return null;

  for (const value of header.split(",")) {
    const protocol = value.trim();
    if (!protocol.startsWith(SCREEN_TOKEN_PROTOCOL_PREFIX)) continue;
    const token = protocol.slice(SCREEN_TOKEN_PROTOCOL_PREFIX.length);
    return token.length > 0 ? token : null;
  }
  return null;
}

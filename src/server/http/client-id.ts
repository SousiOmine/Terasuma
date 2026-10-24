import { CLIENT_HEADER } from "../../shared/api/events";
import { ValidationError } from "../errors";

/**
 * 画面（タブ）の id を読む。
 *
 * 送った画面は、送信の応答としてターンの出来事を受け取っている。購読へも同じものを配ると
 * 二重になるので、サーバはこの id の購読を飛ばす。id は画面が 1 回の読み込みごとに作り、
 * 会話の要求すべてに付ける（付いていなければ、どの購読を飛ばせばよいか決められない）。
 *
 * 変更系の API では、このヘッダを CSRF の門にも使う。独自ヘッダを付けた cross-origin の
 * 要求はプリフライトで止まるので、他サイトのフォームから状態を変えられない。
 * 画面は fetchOrThrow がすべての要求に付ける。
 */
export function requireClientId(headers: Headers): string {
  const clientId = headers.get(CLIENT_HEADER)?.trim() ?? "";
  if (clientId.length === 0) {
    throw new ValidationError(`${CLIENT_HEADER} ヘッダに、画面の id を指定してください`);
  }
  return clientId;
}

/** 変更系の要求だけ、画面の id を必須にする。読み取りとプリフライトは通す。 */
export function requireClientForMutation(request: unknown): void {
  if (typeof request !== "object" || request === null) return;

  const { method, headers } = request as { method?: unknown; headers?: unknown };
  if (typeof method !== "string") return;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  if (!(headers instanceof Headers)) return;

  requireClientId(headers);
}

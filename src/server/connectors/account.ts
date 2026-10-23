import { describeError } from "../../shared/errors";
import { sendRequest } from "../http/client";
import type { ConnectorProvider } from "./providers";

/**
 * 保存したトークンで、接続中のアカウントを読む。
 *
 * 保存の前には必ず verifyAccount を通す。間違ったトークンを黙って保存すると、
 * 次のコマンドで初めて 401 になるため。
 */

/** 1 回の HTTP の上限。応答しないサーバーで接続操作を止めない。 */
const HTTP_TIMEOUT_MS = 15_000;

/** アカウント名を読む 1 回の要求。成否の扱いは呼び出し側が決める。 */
async function requestAccount(provider: ConnectorProvider, accessToken: string): Promise<Response> {
  // パスは API の baseUrl の後ろに付ける（"/user" を URL の解決に任せると origin 直下になる）。
  const base = provider.api.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${provider.api.account.path}`);

  const outcome = await sendRequest(
    fetch,
    url.toString(),
    { headers: { ...provider.api.headers, Authorization: `Bearer ${accessToken}` } },
    { timeoutMs: HTTP_TIMEOUT_MS },
  );

  if (outcome.kind === "network") throw outcome.error;
  return outcome.response;
}

/** 応答からアカウント名を読む。無ければ null。 */
function accountFrom(data: Record<string, unknown>, provider: ConnectorProvider): string | null {
  const value = data[provider.api.account.field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 貼られたトークンでアカウントを読む。
 * 設定画面で保存する前に確かめ、受け付けられないトークンを黙って保存しない。
 */
export async function verifyAccount(provider: ConnectorProvider, accessToken: string): Promise<string> {
  let response: Response;
  try {
    response = await requestAccount(provider, accessToken);
  } catch (error) {
    throw new Error(`Could not reach ${provider.name}: ${describeError(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`${provider.name} did not accept the token (HTTP ${response.status})`);
  }

  const account = accountFrom(await readJsonObject(response), provider);
  if (account === null) throw new Error(`${provider.name} did not return the account name`);

  return account;
}

/** JSON のオブジェクトとして読む。配列や JSON でない応答は失敗にする。 */
async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The server returned an unexpected response");
  }
  return value as Record<string, unknown>;
}

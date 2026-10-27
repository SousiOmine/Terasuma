import { describeError } from "../../shared/errors";
import { sendRequestOrThrow } from "../http/client";
import type { TokenConnectorProvider } from "./providers";

/**
 * 保存したトークンで、そのトークンを受け付けられるかを確かめる。
 *
 * 保存の前には必ず verifyAccount を通す。間違ったトークンを黙って保存すると、
 * 次のコマンドで初めて 401 になるため。
 * 何を読むかは定義（api.auth / api.verify）が決める。GitHub は /user でアカウント名を読み、
 * Composio はキーに対応するアカウント名が無いので、応答の成否だけを見る。
 */

/** 1 回の HTTP の上限。応答しないサーバーで接続操作を止めない。 */
const HTTP_TIMEOUT_MS = 15_000;

/** 確かめる 1 回の要求。宛先は定義の baseUrl の後ろに付ける。 */
async function requestVerify(provider: TokenConnectorProvider, accessToken: string): Promise<Response> {
  // パスは API の baseUrl の後ろに付ける（"/user" を URL の解決に任せると origin 直下になる）。
  const base = provider.api.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${provider.api.verify.path}`);
  const { header, prefix } = provider.api.auth;

  return sendRequestOrThrow(
    fetch,
    url.toString(),
    { headers: { ...provider.api.headers, [header]: `${prefix}${accessToken}` } },
    {
      timeoutMs: HTTP_TIMEOUT_MS,
      // 繋がらなければ、その失敗をそのまま画面へ返す（理由はブラウザの通信の失敗と同じ形）。
      onNetwork: (error) => (error instanceof Error ? error : new Error(String(error))),
    },
  );
}

/** 応答からアカウント名を読む。field が null のコネクタは読まないので null。 */
async function accountFrom(response: Response, provider: TokenConnectorProvider): Promise<string | null> {
  const field = provider.api.verify.field;
  if (field === null) return null;

  const data = await readJsonObject(response);
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 貼られたトークンを確かめる。
 * 設定画面で保存する前に通し、受け付けられないトークンを黙って保存しない。
 * 返すのは接続中のアカウント名で、名前を持たないコネクタでは null。
 */
export async function verifyAccount(provider: TokenConnectorProvider, accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await requestVerify(provider, accessToken);
  } catch (error) {
    throw new Error(`Could not reach ${provider.name}: ${describeError(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`${provider.name} did not accept the token (HTTP ${response.status})`);
  }

  const account = await accountFrom(response, provider);
  if (account === null && provider.api.verify.field !== null) {
    throw new Error(`${provider.name} did not return the account name`);
  }

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

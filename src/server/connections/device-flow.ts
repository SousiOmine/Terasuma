import { describeError } from "../../shared/errors";
import type { DeviceFlowProvider } from "./providers";

/**
 * Device Flow（RFC 8628）の HTTP のやり取り。
 *
 * 認可ページを開くのは画面の役目なので、ここは認可サーバーとの往復だけを持つ。
 * 送る値と読む値は仕様で決まっているため、プロバイダごとの差は URL と scope だけになる。
 */

/** デバイスコードの要求に成功した結果。 */
export type DeviceCode = {
  deviceCode: string;
  /** ユーザーが認可ページへ入力するコード。 */
  userCode: string;
  /** ブラウザで開く認可ページ。 */
  verificationUri: string;
  /** コードの有効期限。epoch ミリ秒。 */
  expiresAt: number;
  /** トークンを問い合わせる間隔（秒）。 */
  intervalSeconds: number;
};

/** トークンの問い合わせ結果。 */
export type TokenPoll =
  | { kind: "token"; accessToken: string; scope: string | null }
  /** まだ承認されていない。間隔を空けて問い合わせ直す。 */
  | { kind: "pending" }
  /** 間隔を空けろと言われた。 */
  | { kind: "slow_down" }
  /** 認可されなかった（拒否・期限切れなど）。 */
  | { kind: "failed"; message: string };

/** 1 回の HTTP の上限。応答しないサーバーでターンを止めない。 */
const HTTP_TIMEOUT_MS = 15_000;

/** GitHub の Device Flow で使う grant_type。 */
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** デバイスコードを要求する。失敗は例外（理由はそのまま画面とモデルに出せる）。 */
export async function requestDeviceCode(provider: DeviceFlowProvider, clientId: string): Promise<DeviceCode> {
  const body = new URLSearchParams({ client_id: clientId, scope: provider.scopes.join(" ") });
  const response = await postForm(provider.deviceCodeUrl, body);

  let data: Record<string, unknown>;
  try {
    data = await readJsonObject(response);
  } catch (error) {
    // Device Flow を有効にしていないアプリや、誤った Client ID では JSON が返らないことが多い。
    throw new Error(
      [
        `Could not start the ${provider.name} sign-in (HTTP ${response.status}).`,
        "Check that the Client ID is correct and that Device Flow is enabled for the OAuth app.",
        describeError(error),
      ].join(" "),
      { cause: error },
    );
  }

  const error = data["error"];
  if (typeof error === "string") {
    throw new Error(`Could not start the ${provider.name} sign-in: ${readError(data)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not start the ${provider.name} sign-in (HTTP ${response.status})`);
  }

  return {
    deviceCode: requireString(data, "device_code"),
    userCode: requireString(data, "user_code"),
    verificationUri: requireString(data, "verification_uri"),
    expiresAt: Date.now() + requireNumber(data, "expires_in") * 1_000,
    // 0 はテスト用の「待たずに問い合わせる」。実在のサーバーは 5 秒以上を返す。
    intervalSeconds: Math.max(readNumber(data, "interval") ?? 5, 0),
  };
}

/** トークンを 1 回問い合わせる。通信の失敗は例外、認可の状態は結果で返す。 */
export async function pollToken(
  provider: DeviceFlowProvider,
  clientId: string,
  deviceCode: string,
): Promise<TokenPoll> {
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_CODE_GRANT,
  });
  const response = await postForm(provider.tokenUrl, body);

  let data: Record<string, unknown>;
  try {
    data = await readJsonObject(response);
  } catch (error) {
    throw new Error(`Could not check the ${provider.name} sign-in (HTTP ${response.status}): ${describeError(error)}`, {
      cause: error,
    });
  }

  const error = data["error"];
  if (error === "authorization_pending") return { kind: "pending" };
  if (error === "slow_down") return { kind: "slow_down" };
  if (typeof error === "string") return { kind: "failed", message: readError(data) };

  if (!response.ok) {
    return { kind: "failed", message: `The ${provider.name} sign-in failed (HTTP ${response.status})` };
  }

  const accessToken = data["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { kind: "failed", message: `The ${provider.name} sign-in did not return an access token` };
  }

  const scope = data["scope"];
  return { kind: "token", accessToken, scope: typeof scope === "string" ? scope : null };
}

/**
 * 接続したアカウントの名前を読む。
 * 名前は画面の飾りなので、読めなくても接続は成立させる（null を返す）。
 */
export async function fetchAccount(provider: DeviceFlowProvider, accessToken: string): Promise<string | null> {
  try {
    // パスは API の baseUrl の後ろに付ける（"/user" を URL の解決に任せると origin 直下になる）。
    const base = provider.api.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}${provider.api.account.path}`);
    const response = await fetch(url, {
      headers: { ...provider.api.headers, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = await readJsonObject(response);
    const value = data[provider.api.account.field];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** フォームを POST する。認可サーバーはフォームの応答を返す。 */
function postForm(url: string, body: URLSearchParams): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // 既定の応答はフォーム形式なので、JSON を明示して読む。
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

/** JSON のオブジェクトとして読む。配列や JSON でない応答は失敗にする。 */
async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The OAuth server returned an unexpected response");
  }
  return value as Record<string, unknown>;
}

/** 失敗の説明。description が無ければ error の名前を使う。 */
function readError(data: Record<string, unknown>): string {
  const description = data["error_description"];
  if (typeof description === "string" && description.length > 0) return description;

  const error = data["error"];
  return typeof error === "string" ? error : "unknown error";
}

function requireString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The OAuth server did not return ${key}`);
  }
  return value;
}

function requireNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`The OAuth server did not return a valid ${key}`);
  }
  return value;
}

function readNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

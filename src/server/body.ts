import {
  isProviderId,
  mcpServerSettingsFromForm,
  normalizeProvider,
  providerSettingsFromForm,
  type McpServerSettings,
  type ProviderSettings,
} from "../config";
import { describeError } from "../shared/errors";
import { isModelId, type ModelId } from "../shared/model";
import type { McpServerForm, ProviderCredentials } from "../shared/types";
import { jsonError } from "./errors";

/**
 * リクエストの本文から値を読み、検証して、保存できる形に整える。
 * 形が違えば、そのまま返せる 400 のレスポンスを返す。
 */

/**
 * 画面から来た MCP サーバーの入力を、保存できる形にする。
 * id と種類ごとの規則の検証は、設定ファイルを読むときと同じ 1 箇所（config.ts）に任せる。
 */
export async function readMcpForm(req: {
  json(): Promise<unknown>;
}): Promise<{ id: string; server: McpServerSettings } | Response> {
  const body = await readJsonBody(req);

  const rawId = body?.["id"];
  const id = typeof rawId === "string" ? rawId.trim() : "";

  const type = body?.["type"];
  if (type !== "stdio" && type !== "http") {
    return jsonError(400, "invalid_request", 'type は "stdio" か "http" にしてください');
  }

  const command = readOptionalString(body, "command");
  const url = readOptionalString(body, "url");
  const args = readOptionalStringList(body, "args");
  const env = readOptionalStringMap(body, "env");
  if (command === undefined || url === undefined || args === undefined || env === undefined) {
    return jsonError(
      400,
      "invalid_request",
      "command, url, args, env は文字列・文字列の配列・文字列の対応表で指定してください",
    );
  }

  const form: McpServerForm = { id, type, command, args, env, url };

  try {
    return { id, server: mcpServerSettingsFromForm(form, `mcpServers.${id}`) };
  } catch (error) {
    return jsonError(400, "invalid_request", describeError(error));
  }
}

/** リクエストからプロバイダ id を読む。 */
export function readProviderId(body: Record<string, unknown> | null): string | null {
  const id = body?.["id"];
  if (typeof id !== "string") return null;

  const trimmed = id.trim();
  return isProviderId(trimmed) ? trimmed : null;
}

/** リクエストから接続情報（apiKey / baseUrl / label）を読む。 */
export function readCredentials(body: Record<string, unknown> | null): ProviderCredentials | null {
  const apiKey = readOptionalString(body, "apiKey");
  const baseUrl = readOptionalString(body, "baseUrl");
  const label = readOptionalString(body, "label");
  if (apiKey === undefined || baseUrl === undefined || label === undefined) return null;

  return { apiKey, baseUrl, label };
}

/** 追加と同時に決める既定のモデル。文字列でない値は弾く。 */
export function readDefaultModel(body: Record<string, unknown> | null): ModelId | null | Response {
  const value = body?.["defaultModel"];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isModelId(value)) {
    return jsonError(400, "invalid_request", 'defaultModel must be a "provider/model" string or null');
  }
  return value;
}

/** 未入力（null / 無し）は null、文字列はそのまま、それ以外は undefined を返す。 */
export function readOptionalString(body: Record<string, unknown> | null, key: string): string | null | undefined {
  const value = body?.[key];
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** 未入力（null / 無し）は null、文字列の配列はそのまま、それ以外は undefined を返す。 */
export function readOptionalStringList(
  body: Record<string, unknown> | null,
  key: string,
): readonly string[] | null | undefined {
  const value = body?.[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value as string[];
}

/** 未入力（null / 無し）は null、文字列→文字列の対応表はそのまま、それ以外は undefined を返す。 */
export function readOptionalStringMap(
  body: Record<string, unknown> | null,
  key: string,
): Record<string, string> | null | undefined {
  const value = body?.[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;

  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entry]) => typeof entry === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * リクエストの本文から接続情報を読み、検証して保存できる形にする。
 * 弾いた場合はそのまま返せる 400 のレスポンスを返す。
 */
export function parseProviderSettings(id: string, body: Record<string, unknown> | null): ProviderSettings | Response {
  const credentials = readCredentials(body);
  if (credentials === null) {
    return jsonError(400, "invalid_request", "apiKey, baseUrl, label must be strings or null");
  }

  try {
    return normalizeProvider(providerSettingsFromForm(credentials), `providers.${id}`);
  } catch (error) {
    return jsonError(400, "invalid_request", describeError(error));
  }
}

/** 本文が無い・JSON でない場合は「本文なし」として扱い、呼び出し側で invalid_request にする。 */
export async function readJsonBody(req: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

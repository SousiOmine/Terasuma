import { describeError } from "../../shared/errors";
import { isProviderId } from "../../shared/ids";
import { isReplyLanguage, type ReplyLanguage } from "../../shared/language";
import { isModelId, type ModelId } from "../../shared/model";
import type { McpServerForm, ProviderCredentials } from "../../shared/types";
import type { UploadFile } from "../computer/uploads";
import { readUploadedFiles } from "../computer/uploads";
import { mcpServerSettingsFromForm, parseProviderCredentials } from "../data/settings-form";
import type { McpServerSettings, ProviderSettings } from "../data/settings-schema";
import { ValidationError } from "../errors";

/**
 * リクエストの本文から値を読み、検証して、保存できる形に整える。
 *
 * 形が違えば ValidationError を投げる。応答への変換は http/respond.ts が行うので、
 * ここは「読めなかった理由」だけを返す。
 */

/**
 * チャットの送信本文。multipart/form-data で受ける。
 * 本文と返事の言語は文字列、添付ファイルは "files" の部品として並ぶ。
 */
export type TurnForm = {
  content: string;
  language: ReplyLanguage;
  files: readonly UploadFile[];
};

/**
 * 送信の multipart を読み、検証した形にする。
 * JSON は受け付けない（ファイルの有無で経路を分けると、片方だけ直し忘れるため）。
 */
export async function readTurnForm(req: { formData(): Promise<FormData> }): Promise<TurnForm> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (error) {
    throw new ValidationError(`multipart/form-data として読めませんでした: ${describeError(error)}`);
  }

  const rawContent = form.get("content");
  if (rawContent !== null && typeof rawContent !== "string") {
    throw new ValidationError("content must be a string");
  }

  const language = form.get("language");
  if (!isReplyLanguage(language)) {
    throw new ValidationError('language must be "ja" or "en"');
  }

  return {
    content: rawContent?.trim() ?? "",
    language,
    files: await readUploadedFiles(form),
  };
}

/**
 * 画面から来た MCP サーバーの入力を、保存できる形にする。
 * id と種類ごとの規則の検証は、設定ファイルを読むときと同じ 1 箇所（settings-form.ts）に任せる。
 */
export async function readMcpForm(req: {
  json(): Promise<unknown>;
}): Promise<{ id: string; server: McpServerSettings }> {
  const body = await readJsonBody(req);

  const rawId = body?.["id"];
  const id = typeof rawId === "string" ? rawId.trim() : "";

  const type = body?.["type"];
  if (type !== "stdio" && type !== "http") {
    throw new ValidationError('type は "stdio" か "http" にしてください');
  }

  const command = readOptionalString(body, "command");
  const url = readOptionalString(body, "url");
  const args = readOptionalStringList(body, "args");
  const env = readOptionalStringMap(body, "env");
  if (command === undefined || url === undefined || args === undefined || env === undefined) {
    throw new ValidationError("command, url, args, env は文字列・文字列の配列・文字列の対応表で指定してください");
  }

  const form: McpServerForm = { id, type, command, args, env, url };

  try {
    return { id, server: mcpServerSettingsFromForm(form, `mcpServers.${id}`) };
  } catch (error) {
    throw new ValidationError(describeError(error));
  }
}

/** リクエストからプロバイダ id を読む。 */
export function readProviderId(body: Record<string, unknown> | null): string {
  const id = body?.["id"];
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!isProviderId(trimmed)) throw new ValidationError("id must be a provider id");
  return trimmed;
}

/** リクエストから接続情報（apiKey / baseUrl / label）を読む。 */
export function readCredentials(body: Record<string, unknown> | null): ProviderCredentials {
  const apiKey = readOptionalString(body, "apiKey");
  const baseUrl = readOptionalString(body, "baseUrl");
  const label = readOptionalString(body, "label");
  if (apiKey === undefined || baseUrl === undefined || label === undefined) {
    throw new ValidationError("apiKey, baseUrl, label must be strings or null");
  }

  return { apiKey, baseUrl, label };
}

/** 追加と同時に決める既定のモデル。文字列でない値は弾く。 */
export function readDefaultModel(body: Record<string, unknown> | null): ModelId | null {
  const value = body?.["defaultModel"];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isModelId(value)) {
    throw new ValidationError('defaultModel must be a "provider/model" string or null');
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
 * 弾いた場合は ValidationError を投げる。
 */
export function parseProviderSettings(id: string, body: Record<string, unknown> | null): ProviderSettings {
  const credentials = readCredentials(body);

  try {
    return parseProviderCredentials(credentials, `providers.${id}`);
  } catch (error) {
    throw new ValidationError(describeError(error));
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

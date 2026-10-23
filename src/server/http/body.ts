import { describeError } from "../../shared/errors";
import { isProviderId } from "../../shared/ids";
import { isReplyLanguage, type ReplyLanguage } from "../../shared/language";
import { isModelId, type ModelId } from "../../shared/model";
import type { McpServerForm, ProviderCredentials, WebSearchProviderForm } from "../../shared/types";
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
 * チャットの発言。multipart/form-data で受ける。
 * 本文は文字列、添付ファイルは "files" の部品として並ぶ。
 */
export type MessageForm = {
  content: string;
  files: readonly UploadFile[];
};

/** ターンを始める送信。返事の言語も持つ。 */
export type TurnForm = MessageForm & {
  language: ReplyLanguage;
};

/**
 * 送信の multipart を読み、検証した形にする。
 * JSON は受け付けない（ファイルの有無で経路を分けると、片方だけ直し忘れるため）。
 */
export async function readTurnForm(req: { formData(): Promise<FormData> }): Promise<TurnForm> {
  const form = await readFormData(req);

  const language = form.get("language");
  if (!isReplyLanguage(language)) {
    throw new ValidationError('language must be "ja" or "en"');
  }

  return {
    content: readContent(form),
    language,
    files: await readUploadedFiles(form),
  };
}

/**
 * 応答中の割り込みの multipart を読む。
 * 返事の言語は走っているターンのものを使うので、ここでは読まない。
 */
export async function readSteerForm(req: { formData(): Promise<FormData> }): Promise<MessageForm> {
  const form = await readFormData(req);
  return { content: readContent(form), files: await readUploadedFiles(form) };
}

async function readFormData(req: { formData(): Promise<FormData> }): Promise<FormData> {
  try {
    return await req.formData();
  } catch (error) {
    throw new ValidationError(`multipart/form-data として読めませんでした: ${describeError(error)}`);
  }
}

/** 本文を取り出す。無ければ空文字、文字列でなければ断る。 */
function readContent(form: FormData): string {
  const rawContent = form.get("content");
  if (rawContent !== null && typeof rawContent !== "string") {
    throw new ValidationError("content must be a string");
  }
  return rawContent?.trim() ?? "";
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

/**
 * 画面から来た検索プロバイダの入力を読む。
 * 変更では apiKey を省ける（null なら保存済みのキーを使う）。
 */
export async function readWebSearchForm(req: { json(): Promise<unknown> }): Promise<WebSearchProviderForm> {
  const body = await readJsonBody(req);
  const id = readOptionalString(body, "id");
  const apiKey = readOptionalString(body, "apiKey");
  if (id === undefined || apiKey === undefined) {
    throw new ValidationError("id, apiKey must be strings or null");
  }

  return { id: id?.trim() ?? "", apiKey };
}

/**
 * 画面から来た Application ID を読む。null は「設定を消す」。
 * 空の文字列も「消す」として扱う（入力欄を空にしたときの見た目と揃える）。
 */
export async function readConnectionClientIdForm(req: { json(): Promise<unknown> }): Promise<{ clientId: string | null }> {
  const body = await readJsonBody(req);
  const clientId = readOptionalString(body, "clientId");
  if (clientId === undefined) throw new ValidationError("clientId must be a string or null");

  const trimmed = clientId?.trim() ?? "";
  return { clientId: trimmed.length === 0 ? null : trimmed };
}

/**
 * 画面から来たトークンを読む。空欄は受け付けない（消すときは切断を使う）。
 */
export async function readConnectionTokenForm(req: { json(): Promise<unknown> }): Promise<{ token: string }> {
  const body = await readJsonBody(req);
  const token = readOptionalString(body, "token");
  if (token === undefined) throw new ValidationError("token must be a string");

  const trimmed = token?.trim() ?? "";
  if (trimmed.length === 0) throw new ValidationError("token must not be empty");

  return { token: trimmed };
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

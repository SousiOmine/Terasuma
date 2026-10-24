import { describeError } from "../../shared/errors";
import { isProviderId } from "../../shared/ids";
import { isReplyLanguage, type ReplyLanguage } from "../../shared/language";
import { isModelId, type ModelId } from "../../shared/model";
import type { McpServerForm, ProviderCredentials, WebSearchProviderForm } from "../../shared/api/settings";
import type { UploadFile } from "../computer/uploads";
import { readUploadedFiles } from "../computer/uploads";
import { mcpServerSettingsFromForm, parseProviderCredentials } from "../data/settings";
import type { McpServerSettings, ProviderSettings } from "../data/settings";
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

/**
 * JSON の本文を読むのに要る形。
 * Bun の Request がそのまま満たす（テストでは素のオブジェクトでも渡せる）。
 */
export type JsonRequest = {
  text(): Promise<string>;
  headers: Headers;
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
 * 再試行の multipart を読む。返事の言語だけを受け取り、本文とファイルは読まない
 * （最後のユーザー発言をそのまま使う）。
 */
export async function readRetryForm(req: { formData(): Promise<FormData> }): Promise<{ language: ReplyLanguage }> {
  const form = await readFormData(req);

  const language = form.get("language");
  if (!isReplyLanguage(language)) {
    throw new ValidationError('language must be "ja" or "en"');
  }

  return { language };
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
export async function readMcpForm(req: JsonRequest): Promise<{ id: string; server: McpServerSettings }> {
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
export async function readWebSearchForm(req: JsonRequest): Promise<WebSearchProviderForm> {
  const body = await readJsonBody(req);
  const id = readOptionalString(body, "id");
  const apiKey = readOptionalString(body, "apiKey");
  if (id === undefined || apiKey === undefined) {
    throw new ValidationError("id, apiKey must be strings or null");
  }

  return { id: id?.trim() ?? "", apiKey };
}

/**
 * 画面から来た webhook URL を読む。空欄は受け付けない（消すときは切断を使う）。
 */
export async function readDiscordWebhookForm(req: JsonRequest): Promise<{ url: string }> {
  const body = await readJsonBody(req);
  const url = readOptionalString(body, "url");
  if (url === undefined) throw new ValidationError("url must be a string");

  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) throw new ValidationError("url must not be empty");

  return { url: trimmed };
}

/**
 * program コネクタの設定を読む。本文は省略できる（キーが無ければ、いまの設定を確かめるだけ）。
 * 値は前後の空白を落とし、無い項目は undefined にする。
 */
export async function readConnectorSetupForm(req: JsonRequest): Promise<{
  provider?: string;
  apiKey?: string;
  model?: string;
}> {
  const body = await readJsonBody(req);

  const provider = readSetupString(body, "provider");
  const apiKey = readSetupString(body, "apiKey");
  const model = readSetupString(body, "model");

  return {
    ...(provider === undefined ? {} : { provider }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(model === undefined ? {} : { model }),
  };
}

/** 設定の入力 1 つ。無ければ undefined、文字列なら前後の空白を落とす。 */
function readSetupString(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${key} must be a string`);
  return value.trim();
}

/**
 * 画面から来たトークンを読む。空欄は受け付けない（消すときは切断を使う）。
 */
export async function readConnectorTokenForm(req: JsonRequest): Promise<{ token: string }> {
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

/**
 * JSON の本文を読む。
 *
 * 本文が空なら null（任意の項目だけを受け取る経路のため）。
 * 壊れた JSON や JSON でない Content-Type は、その場で 400 にする。
 * 「teraId を指定してください」のような、本文の壊れ方と関係のない理由にしないため。
 */
export async function readJsonBody(req: JsonRequest): Promise<Record<string, unknown> | null> {
  const text = (await req.text()).trim();
  if (text.length === 0) return null;

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ValidationError("Content-Type は application/json にしてください");
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`本文を JSON として読めませんでした: ${describeError(error)}`);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("本文は JSON のオブジェクトにしてください");
  }
  return body as Record<string, unknown>;
}

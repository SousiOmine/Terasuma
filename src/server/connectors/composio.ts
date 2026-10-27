import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { describeError } from "../../shared/errors";
import { recordOf } from "../../shared/guards";
import { truncateText } from "../../shared/text";
import { COMPOSIO_EXECUTE_TOOL_NAME, COMPOSIO_SEARCH_TOOL_NAME, connectAppToolName } from "../../shared/tools";
import { sendRequest } from "../http/client";
import type { ConnectorsManager } from "./manager";

/**
 * Composio のツール。
 *
 * Composio は 1,600 以上のアプリのツールを、1 つのプロジェクト API キーで扱う。
 * アプリごとの接続ツール（app_connect_<id>）は作らず、検索と実行の 2 つだけを置く。
 * アプリの接続（OAuth）は Composio のダッシュボードで済ませる。
 *
 * どちらもツール一覧には載せず、tool_search で見つけて tool_call で実行する。
 * キーは Terasuma のサーバーが使い、コンテナへは渡さない（env を空にしている）。
 *
 * connected account は Composio の user_id に紐付く。Terasuma は全 Tera で 1 つの
 * user_id を使うので、同じインスタンスの全 Tera が同じ接続を共有する。
 */

/** 設定でのコネクタ id。 */
export const COMPOSIO_CONNECTOR_ID = "composio";

/** 接続（connected account）を紐付ける user_id。この設置者 1 人分として扱う。 */
export const COMPOSIO_USER_ID = "terasuma";

/** API 1 回の待ち時間。応答しないサーバーでターンを止めない。 */
const API_TIMEOUT_MS = 60_000;

/** モデルへ返す本文の上限（文字数）。 */
const MAX_RESULT_CHARS = 20_000;

/** 1 回の検索で返すツールの数。 */
const SEARCH_LIMIT = 20;

/** 1 つの引数の説明の上限（文字数）。 */
const MAX_ARGUMENT_CHARS = 120;

type ToolContext = { abortSignal?: AbortSignal };

/** 検索の引数。 */
type SearchInput = { query: string; toolkit?: string };

/** 実行の引数。 */
type ExecuteInput = { toolSlug: string; args?: Record<string, unknown> };

/** Composio のツール一式。未接続でも 2 つを返し、実行時に接続を促す。 */
export function createComposioTools(options: { connectors: ConnectorsManager }): ToolSet {
  const { connectors } = options;

  /** 接続済みのキーと、叩き先。未接続なら、接続ツールを案内して失敗する。 */
  function connection(): { token: string; baseUrl: string } {
    const token = connectors.token(COMPOSIO_CONNECTOR_ID);
    if (token === null) {
      throw new Error(
        `Composio is not connected. Call ${connectAppToolName(COMPOSIO_CONNECTOR_ID)} and let the user save the project API key first.`,
      );
    }

    const provider = connectors.provider(COMPOSIO_CONNECTOR_ID);
    if (provider.kind !== "token") throw new Error("Composio must be a token connector.");

    return { token, baseUrl: provider.api.baseUrl.replace(/\/+$/, "") };
  }

  async function call(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const { token, baseUrl } = connection();
    const provider = connectors.provider(COMPOSIO_CONNECTOR_ID);
    if (provider.kind !== "token") throw new Error("Composio must be a token connector.");

    const { header, prefix } = provider.api.auth;
    const headers: Record<string, string> = {
      ...provider.api.headers,
      [header]: `${prefix}${token}`,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    const outcome = await sendRequest(
      fetch,
      `${baseUrl}${path}`,
      { method: init.method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) },
      { timeoutMs: API_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );

    if (outcome.kind === "network") {
      throw new Error(`Could not reach Composio: ${describeError(outcome.error)}`, { cause: outcome.error });
    }

    const response = outcome.response;
    if (response.status === 401) {
      throw new Error(
        `Composio rejected the saved API key (HTTP 401). The key may be revoked, or it may lack the permissions this call needs; ask the user to save a key with ${connectAppToolName(COMPOSIO_CONNECTOR_ID)}.`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Composio answered HTTP ${response.status}: ${truncateText(text, 400, "marked")}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error("Composio returned a response that is not JSON.", { cause: error });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Composio returned an unexpected response.");
    }
    return value as Record<string, unknown>;
  }

  return {
    [COMPOSIO_SEARCH_TOOL_NAME]: tool({
      description: [
        "Find tools in Composio's catalog (Gmail, Slack, Notion, GitHub and others) and return their slugs, descriptions and arguments.",
        "Start here when a task needs an app that Composio covers. Pass the toolkit slug to narrow the search to one app.",
        "Run a result with app_composio_execute, using the slug and arguments shown here.",
      ].join(" "),
      inputSchema: z.object({
        query: z.string().min(1).describe('What you want to do, in a few words (for example "send an email")'),
        toolkit: z
          .string()
          .min(1)
          .optional()
          .describe('Limit the search to one app, by its toolkit slug (for example "gmail")'),
      }),
      execute: async ({ query, toolkit }: SearchInput, context: ToolContext) => {
        const params = new URLSearchParams({ query, limit: String(SEARCH_LIMIT) });
        if (toolkit !== undefined) params.set("toolkit_slug", toolkit);

        const body = await call(`/tools?${params.toString()}`, { method: "GET" }, context.abortSignal);
        return searchText(body, query, toolkit ?? null);
      },
    }),

    [COMPOSIO_EXECUTE_TOOL_NAME]: tool({
      description: [
        "Run one Composio tool by its slug, with the arguments its schema shows (find the slug with app_composio_search).",
        "The Composio project API key and the connected account are used by Terasuma and are never shown to you.",
        "A result with successful false is a failed run: read error and fix the arguments or the connection.",
      ].join(" "),
      inputSchema: z.object({
        toolSlug: z.string().min(1).describe('Tool slug from app_composio_search, for example "GMAIL_SEND_EMAIL"'),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments for the tool, as the schema from app_composio_search describes them"),
      }),
      execute: async ({ toolSlug, args }: ExecuteInput, context: ToolContext) => {
        const body = await call(
          `/tools/execute/${encodeURIComponent(toolSlug)}`,
          { method: "POST", body: { user_id: COMPOSIO_USER_ID, arguments: args ?? {}, version: "latest" } },
          context.abortSignal,
        );

        // 実行の失敗は HTTP 200 で返る。successful と error で判定する。
        if (body["successful"] !== true) {
          const reason = typeof body["error"] === "string" && body["error"].length > 0 ? body["error"] : "no reason";
          throw new Error(`Composio ran ${toolSlug} but it failed: ${truncateText(reason, 400, "marked")}`);
        }

        const data = body["data"];
        const text = data === undefined ? "" : JSON.stringify(data, null, 2);
        return `${toolSlug} ran.${text.length === 0 ? "" : `\n${truncateText(text, MAX_RESULT_CHARS, "marked")}`}`;
      },
    }),
  };
}

/** 検索の応答を、モデルが読める一覧にする。 */
function searchText(body: Record<string, unknown>, query: string, toolkit: string | null): string {
  const items = Array.isArray(body["items"]) ? body["items"] : [];
  const where = toolkit === null ? "" : ` in ${toolkit}`;

  if (items.length === 0) {
    return `No Composio tool matches "${query}"${where}. Try other words, or drop the toolkit filter.`;
  }

  const lines = [`Found ${items.length} tool(s) for "${query}"${where}.`, ""];
  for (const item of items) {
    const entry = recordOf(item);
    if (entry === null) continue;

    const slug = stringOf(entry["slug"]) ?? "(unknown slug)";
    const app = stringOf(recordOf(entry["toolkit"])?.["slug"]) ?? "";
    const name = stringOf(entry["name"]) ?? "";
    lines.push(`- ${slug}${app.length === 0 ? "" : ` (${app})`}${name.length === 0 ? "" : `: ${name}`}`);

    const description = stringOf(entry["description"]);
    if (description !== null && description.length > 0) {
      lines.push(`  ${truncateText(oneLine(description), 400, "marked")}`);
    }

    const args = argumentsOf(entry["input_parameters"]);
    if (args.length > 0) lines.push(`  Arguments: ${args.join(", ")}`);
  }

  lines.push("", "Run one with app_composio_execute.");
  return truncateText(lines.join("\n"), MAX_RESULT_CHARS, "marked");
}

/** input_parameters の各項目を "name (type, required)" の 1 行にする。 */
function argumentsOf(value: unknown): string[] {
  const record = recordOf(value);
  if (record === null) return [];

  const parts: string[] = [];
  for (const [name, raw] of Object.entries(record)) {
    const definition = recordOf(raw);
    const type = definition === null ? null : stringOf(definition["type"]);
    const required = definition !== null && definition["required"] === true;
    const description = definition === null ? null : stringOf(definition["description"]);

    const shape = [type ?? "any", required ? "required" : "optional"].join(", ");
    const note =
      description === null || description.length === 0
        ? ""
        : `: ${truncateText(oneLine(description), MAX_ARGUMENT_CHARS, "marked")}`;
    parts.push(`${name} (${shape})${note}`);
  }
  return parts;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

import { asSchema, type ToolSet } from "ai";
import { messageOf } from "../../../shared/errors";
import { truncateText } from "../../../shared/text";
import { splitToolName } from "../../../shared/tools";

/**
 * モデルのツール一覧に載せないツールの置き場。
 *
 * MCP サーバーのツールは、サーバーが増えるほど定義（とくに引数の JSON Schema）が大きくなる。
 * すべてを毎回のリクエストへ載せると、使わないツールの分だけ文脈と料金が増える。
 * ここに置いたツールは tool_search で名前・説明・引数スキーマを見つけ、tool_call で実行する。
 * モデルへ渡るツール一覧は、検索と実行の 2 つと、事前に載せるツール
 * （read / write / edit / bash / chat_attach / skill）だけになる。
 */

/** 1 回の検索で返す件数。 */
export const DEFAULT_SEARCH_LIMIT = 10;

/** 1 回の検索で返せる件数の上限。 */
export const MAX_SEARCH_LIMIT = 20;

/** 検索結果に載せる説明の上限（文字数）。 */
const MAX_DESCRIPTION_CHARS = 1_000;

/** 検索結果に載せる引数スキーマの上限（文字数）。 */
const MAX_SCHEMA_CHARS = 2_000;

/** 一覧（検索語なし）の上限（文字数）。 */
const MAX_BROWSE_CHARS = 4_000;

/** 一覧で 1 グループに並べる名前の数。 */
const BROWSE_GROUP_LIMIT = 50;

/** 検索に当たったツール 1 件。text はモデルへ渡す本文そのもの。 */
export type ToolMatch = {
  name: string;
  text: string;
};

/** 実行に渡す、ターンの中断と、モデルが発行した呼び出しの id。 */
export type ToolCallOptions = {
  toolCallId: string;
  abortSignal?: AbortSignal;
};

export type ToolRegistry = {
  /** 見つけられるツールの名前（名前順）。 */
  names(): readonly string[];
  /** 名前と説明のキーワード検索。 */
  search(query: string, limit: number): readonly ToolMatch[];
  /** 名前だけの一覧（検索語が無いときと、検索に当たらなかったとき）。 */
  browse(): string;
  /** 名前で実行する。失敗は例外にして、モデルには理由だけを渡す。 */
  call(name: string, args: unknown, options: ToolCallOptions): Promise<unknown>;
};

/** レジストリが 1 つのツールについて持つもの。 */
type Entry = {
  name: string;
  /** 検索で見る小文字の文字列（名前と説明）。 */
  haystack: string;
  /** 検索結果に載せる本文。 */
  text: string;
  /** 引数の検証。無ければ検証しない（MCP はサーバーが検証する）。 */
  validate: ((value: unknown) => unknown) | null;
  /** 実行する関数。実行を持たないツールは undefined。 */
  execute: ((input: never, options: never) => unknown) | undefined;
};

/** ツール一式から、検索と実行のできるレジストリを作る。 */
export async function createToolRegistry(tools: ToolSet): Promise<ToolRegistry> {
  const entries = new Map<string, Entry>();

  for (const [name, definition] of Object.entries(tools)) {
    const description = typeof definition.description === "string" ? definition.description : "";
    const schema = asSchema(definition.inputSchema);
    const json = await schema.jsonSchema;
    const validate = schema.validate;

    // 検索は名前・説明・引数の説明から当てる。引数の description には、
    // 何をするツールかを判断する手がかりが入っていることが多い。
    // 名前の区切りも空白に開いておき、"computer screenshot" のような語の並びで当たるようにする。
    const searchText = `${name}\n${name.split("_").join(" ")}\n${description}\n${schemaDescriptions(json)}`;

    entries.set(name, {
      name,
      haystack: searchText.toLowerCase(),
      text: entryText(name, description, json),
      validate: validate === undefined ? null : (value) => validate(value),
      execute: executableOf(definition),
    });
  }

  const sorted = [...entries.keys()].sort((left, right) => left.localeCompare(right));

  return {
    names() {
      return sorted;
    },

    search(query, limit) {
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0);
      if (terms.length === 0) return [];

      const scored: { entry: Entry; score: number }[] = [];
      for (const entry of entries.values()) {
        const score = rank(entry, terms);
        if (score > 0) scored.push({ entry, score });
      }

      scored.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name));
      return scored.slice(0, clampLimit(limit)).map(({ entry }) => ({ name: entry.name, text: entry.text }));
    },

    browse() {
      return browseListing(sorted);
    },

    async call(name, args, options) {
      const entry = entries.get(name);
      if (entry === undefined) throw new Error(`Unknown tool "${name}". Use tool_search to find available tools.`);

      if (entry.validate !== null) {
        const result = (await entry.validate(args)) as { success: boolean; error?: unknown };
        if (!result.success) throw new Error(`Invalid arguments for "${name}": ${describeValidation(result.error)}`);
      }
      if (entry.execute === undefined) throw new Error(`"${name}" cannot be called through tool_call`);

      return entry.execute(
        args as never,
        {
          toolCallId: options.toolCallId,
          messages: [],
          abortSignal: options.abortSignal,
        } as never,
      );
    },
  };
}

/** 名前と説明に対する重み付きの一致。名前の完全一致 > 名前の部分一致 > 説明の一致。 */
function rank(entry: Entry, terms: readonly string[]): number {
  const name = entry.name.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.includes(term)) score += 50;
    if (entry.haystack.includes(term)) score += 10;
  }
  return score;
}

/** 件数を、レジストリが受け付ける範囲に収める。 */
function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
}

/** 検索結果の 1 件分の本文。引数があるときだけ JSON Schema を添える。 */
function entryText(name: string, description: string, schema: unknown): string {
  const summary =
    description.trim().length === 0 ? "(no description)" : truncateText(description, MAX_DESCRIPTION_CHARS, "marked");
  const lines = [`- ${name}`, `  ${summary}`];
  const args = schemaText(schema);
  if (args !== null) lines.push(args);
  return lines.join("\n");
}

/**
 * 引数スキーマの本文。
 * 引数の無いツールには載せず、大きすぎるスキーマは載せない（切り詰めた JSON は読めないため）。
 */
function schemaText(schema: unknown): string | null {
  if (typeof schema !== "object" || schema === null) return null;

  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return null;
  if (Object.keys(properties).length === 0) return null;

  const text = JSON.stringify(schema);
  if (text === undefined || text.length > MAX_SCHEMA_CHARS) {
    return [
      "  Arguments: the schema is too large to show here.",
      "  Pass the arguments its description names; the tool checks them itself.",
    ].join("\n");
  }

  return ["  Arguments (JSON Schema):", `  ${text}`].join("\n");
}

/**
 * 名前だけの一覧。ツール名の前半（サーバー id）ごとに並べる。
 * 名前が増えても読めるように、グループごとの件数と、省いた件数を添える。
 */
function browseListing(names: readonly string[]): string {
  if (names.length === 0) return "No tools are available; nothing can be found with tool_search.";

  const groups = new Map<string, string[]>();
  const hidden = new Map<string, number>();
  for (const name of names) {
    const group = groupOf(name);
    const shown = groups.get(group) ?? [];
    if (shown.length < BROWSE_GROUP_LIMIT) shown.push(name);
    else hidden.set(group, (hidden.get(group) ?? 0) + 1);
    groups.set(group, shown);
  }

  const lines = [
    `${names.length} tool(s) available across ${groups.size} group(s); search a specific one with tool_search.`,
  ];
  for (const [group, shown] of groups) {
    const more = hidden.get(group) ?? 0;
    const omitted = more === 0 ? "" : `; +${more} more — search with tool_search`;
    lines.push(`${group} (${shown.length}${omitted}): ${shown.join(", ")}`);
  }

  const text = lines.join("\n");
  return text.length <= MAX_BROWSE_CHARS ? text : `${text.slice(0, MAX_BROWSE_CHARS)}\n… (listing truncated)`;
}

/** 一覧のまとまり。ツール名の前半（サーバー id）を使う。 */
function groupOf(name: string): string {
  const { server } = splitToolName(name);
  return server.length === 0 ? "(no server)" : server;
}

/** ツールの実行関数。実行を持たないツールは undefined（tool_call からは呼べない）。 */
function executableOf(definition: ToolSet[string]): ((input: never, options: never) => unknown) | undefined {
  const execute = (definition as { execute?: unknown }).execute;
  return typeof execute === "function" ? (execute as (input: never, options: never) => unknown) : undefined;
}

/** 検証の失敗から、モデルが読める 1 文を取り出す。 */
function describeValidation(error: unknown): string {
  return messageOf(error) ?? String(error);
}

/**
 * 引数スキーマの中の説明を、検索用に集める。
 * JSON Schema の properties / items / anyOf などを再帰的にたどり、description だけを拾う。
 */
function schemaDescriptions(schema: unknown): string {
  const parts: string[] = [];
  collectDescriptions(schema, parts);
  return parts.join("\n");
}

function collectDescriptions(value: unknown, into: string[]): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectDescriptions(item, into);
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.description === "string") into.push(record.description);
  for (const child of Object.values(record)) collectDescriptions(child, into);
}

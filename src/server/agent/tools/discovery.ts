import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_CALL_TOOL_NAME, TOOL_SEARCH_TOOL_NAME } from "../../../shared/tools";
import { isRecord } from "../../../shared/guards";
import { describeToolFailure } from "../tool-failure";
import { readToolOutput } from "../tool-output";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, type ToolRegistry } from "./registry";

/**
 * モデルのツール一覧に載せないツールを、検索して実行するための 2 つ。
 *
 * 一覧を渡さない代わりに、モデルは名前・説明・引数スキーマをここで知り、tool_call で実行する。
 * レジストリは毎回 getter から引き直す。ターンの途中で MCP サーバーを足して
 * レジストリが差し替わっても、その場から新しいツールが見つかる。
 */

/** tool_search と tool_call の組。registry は呼び出しのたびに引く。 */
export function createDiscoveryTools(registry: () => ToolRegistry): ToolSet {
  return {
    [TOOL_SEARCH_TOOL_NAME]: tool({
      description: [
        "Find tools that are not in your tool list (MCP server tools, the computer_ tools, app_request, the Discord tools, and tera_create) and return their names, descriptions and argument schemas.",
        "Omitting the query lists every available tool by name.",
        'A query that matches nothing answers with `No tools match "<query>"` followed by that listing, so a miss still shows what exists.',
        "Run a match with tool_call.",
      ].join(" "),
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Search terms: tool or server names, or keywords describing what the tool does"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(
            `Maximum number of matching tools to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT})`,
          ),
      }),
      execute: async ({ query, limit }: { query?: string; limit?: number }) => {
        const current = registry();
        const text = (query ?? "").trim();
        if (text.length === 0) return current.browse();

        const matches = current.search(text, limit ?? DEFAULT_SEARCH_LIMIT);
        if (matches.length === 0) return `No tools match "${text}".\n\n${current.browse()}`;

        return [
          `Found ${matches.length} tool(s) matching "${text}".`,
          "",
          matches.map((match) => match.text).join("\n\n"),
          "",
          "Run one with tool_call(name, args).",
        ].join("\n");
      },
    }),

    [TOOL_CALL_TOOL_NAME]: tool({
      description: [
        "Run a tool found with tool_search, by its exact name, with the arguments its search result describes.",
        "The result is prefixed with `[<tool name>]` so the output stays attributed.",
        "An unknown name fails with `No tool named <name>. Use tool_search to find the name, then call it with tool_call.`",
      ].join(" "),
      inputSchema: z.object({
        name: z.string().min(1).describe("Exact name of the tool to run (returned by tool_search)"),
        args: z
          .union([z.record(z.string(), z.unknown()), z.string()])
          .optional()
          .describe("Tool arguments as described by tool_search (omit when the tool takes none)"),
      }),
      execute: async (
        { name, args }: { name: string; args?: Record<string, unknown> | string },
        context: { toolCallId: string; abortSignal?: AbortSignal },
      ) => {
        const output = await callTool(registry(), name, args, {
          toolCallId: context.toolCallId,
          ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
        });

        // 本文はそのまま渡し、画像は実行したツールの戻り値から引き継ぐ
        // （computer_screenshot の画像が、tool_call 越しでもモデルへ届くようにする）。
        const { text, images } = readToolOutput(output);
        return { text: `[${name}]\n${text}`, ...(images.length === 0 ? {} : { images }) };
      },
    }),
  };
}

/** tool_call の args を、実行に渡すオブジェクトにする。JSON 文字列も受ける。 */
function argumentsOf(args: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (args === undefined) return {};
  if (typeof args !== "string") return args;

  const text = args.trim();
  if (text.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('args must be a JSON object, for example {"name":"..."}.');
  }
  if (!isRecord(parsed)) throw new Error('args must be a JSON object, for example {"name":"..."}.');
  return parsed;
}

/** ツールを実行し、中断以外の失敗はモデルが直せる短い文に置き換える。 */
async function callTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown> | string | undefined,
  options: { toolCallId: string; abortSignal?: AbortSignal },
): Promise<unknown> {
  try {
    return await registry.call(name, argumentsOf(args), options);
  } catch (error) {
    if (options.abortSignal?.aborted === true) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error(describeToolFailure(name, error));
  }
}

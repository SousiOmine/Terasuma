import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { McpServerStatusView } from "../../shared/api/settings";
import { describeError } from "../../shared/errors";
import { MCP_ADD_SERVER_TOOL_NAME, MCP_REMOVE_SERVER_TOOL_NAME, toolNameFor } from "../../shared/tools";
import type { McpManageToolsetProvider } from "../agent/contracts";
import { mcpServerSettingsFromForm, type McpServerSettings, type SettingsStore } from "../data/settings";
import type { McpManager } from "./manager";

/**
 * MCP サーバーを足す・消す内蔵ツール。
 *
 * 足したサーバーは保存したうえで、その場で接続を試す。繋がればツールは同じターンから
 * tool_search で見つかる（エンジンがターンの途中でレジストリを組み直す）。
 * 接続に失敗しても設定は残す（サーバーが落ちているだけのことがあり、直せば使えるため）。
 *
 * env は受け付けない。秘密を会話に残さないため、環境変数が要るサーバーは
 * 利用者が 設定 > MCP から足す。
 *
 * ツール一覧には載せず、tool_search で見つけて tool_call で実行する。
 */

/** mcp_add_server の引数。env は無い（秘密を会話に残さないため）。 */
type AddInput = {
  id: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
};

type RemoveInput = { id: string };

/** 追加・削除のツール一式を作る。設定と接続の実体はアプリが渡す。 */
export function createMcpManageToolset(options: {
  settings: SettingsStore;
  mcp: McpManager;
}): McpManageToolsetProvider {
  return { toolset: () => createMcpManageTools(options) };
}

function createMcpManageTools({ settings, mcp }: { settings: SettingsStore; mcp: McpManager }): ToolSet {
  return {
    [MCP_ADD_SERVER_TOOL_NAME]: tool({
      description: [
        "Add an MCP server to this Tera's settings and connect it now.",
        'type is "stdio" (set command and optional args) or "http" (set url).',
        'The server\'s tools become available as "<id>_<tool name>"; you can search them with tool_search and run them with tool_call in this same turn once it connects.',
        "env is not accepted, because secrets must not stay in the conversation. A server that needs secrets in environment variables must be added by the user in Settings > MCP.",
        "An id that already exists fails and changes nothing.",
      ].join(" "),
      inputSchema: z.object({
        id: z
          .string()
          .min(1)
          .describe(
            'Server id and prefix of its tool names: lowercase letters, digits and hyphens, starting with a letter or digit (for example "github")',
          ),
        type: z.enum(["stdio", "http"]).describe('"stdio" for a command started on this machine, "http" for a URL'),
        command: z.string().min(1).optional().describe("Command to start (stdio only)"),
        args: z.array(z.string().min(1)).optional().describe("Arguments for the command (stdio only)"),
        url: z.string().min(1).optional().describe("Server URL (http only)"),
      }),
      execute: async ({ id, type, command, args, url }: AddInput) => {
        if (settings.read().mcpServers[id] !== undefined) {
          throw new Error(
            `An MCP server with id ${JSON.stringify(id)} already exists; choose another id, or remove it first with ${MCP_REMOVE_SERVER_TOOL_NAME}.`,
          );
        }

        // 画面と同じ規則で検証する（id の予約語もここで弾かれる）。
        const server = mcpServerSettingsFromForm(
          {
            id,
            type,
            command: command ?? null,
            args: args ?? null,
            env: null,
            url: url ?? null,
          },
          `mcpServers.${id}`,
        );

        settings.putMcpServer(id, server);

        // 接続の失敗は例外にしない。設定は保存済みなので、繋がらなくても本文で理由を返す。
        let status: McpServerStatusView;
        try {
          status = await mcp.check(id);
        } catch (error) {
          status = { state: "failed", tools: [], detail: describeError(error) };
        }

        return addedServerText(id, server, status);
      },
    }),

    [MCP_REMOVE_SERVER_TOOL_NAME]: tool({
      description: [
        "Remove an MCP server from this Tera's settings and disconnect it.",
        "Its tools stop being available immediately.",
        "Call this only after the user has said it is fine to remove the server; do not remove one on your own.",
      ].join(" "),
      inputSchema: z.object({
        id: z.string().min(1).describe("Server id shown in Settings > MCP, and the prefix of its tool names"),
      }),
      execute: async ({ id }: RemoveInput) => {
        if (settings.read().mcpServers[id] === undefined) {
          throw new Error(`No MCP server has id ${JSON.stringify(id)}; nothing was removed.`);
        }

        if (!settings.deleteMcpServer(id)) {
          throw new Error(`MCP server ${JSON.stringify(id)} could not be removed from the settings.`);
        }
        await mcp.forget(id);

        return [
          `Removed MCP server ${JSON.stringify(id)}.`,
          `Its tools (names starting with "${id}_") are no longer available; do not call them again.`,
        ].join(" ");
      },
    }),
  };
}

/** 追加した結果の本文。繋がったかどうかで、次にすることを変える。 */
function addedServerText(id: string, server: McpServerSettings, status: McpServerStatusView): string {
  const lines = [`Added MCP server ${JSON.stringify(id)} (${server.type}).`];

  if (status.state === "connected") {
    const names = status.tools.map((name) => toolNameFor(id, name));
    lines.push(
      names.length === 0
        ? "It is connected, but it publishes no tools."
        : `It is connected. Its tools are: ${names.join(", ")}.`,
    );
    lines.push("You can use them now in this same turn: find one with tool_search and run it with tool_call.");
    return lines.join("\n");
  }

  if (status.state === "authorization_required") {
    lines.push(
      "It needs authorization. Ask the user to open Settings > MCP and press Authorize; until then its tools are not available in this turn.",
    );
    return lines.join("\n");
  }

  if (status.state === "failed") {
    lines.push(
      `It could not connect: ${status.detail ?? "no detail was available"}. The settings are saved, so the user can fix or remove it in Settings > MCP.`,
    );
    return lines.join("\n");
  }

  lines.push(
    "Its connection state is not known yet. The settings are saved; once it connects, find its tools with tool_search.",
  );
  return lines.join("\n");
}

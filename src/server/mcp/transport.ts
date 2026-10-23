import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerSettings } from "../data/settings";
import type { ConnectionMaterial } from "./connection";
import { McpOAuthProvider, type OAuthStorage } from "./oauth";

/**
 * 1 つの MCP サーバーへ繋ぐための材料を作る。
 *
 * stdio は子プロセスを、http は OAuth の口を持つ HTTP の transport を返す。
 * 認可が要るかどうかは設定に書かず、http には常に口を渡しておく（401 が返ってきたときだけ始まる）。
 */
export type ConnectionInput = {
  serverId: string;
  server: McpServerSettings;
  /** 認可コードの受け取り先。まだ決まっていなければ例外にする。 */
  callbackUrl(): URL;
  /** 認可の材料を保存する口。 */
  storage(): OAuthStorage;
};

export function connectionMaterial(input: ConnectionInput): ConnectionMaterial {
  const { serverId, server } = input;

  if (server.type === "stdio") {
    return {
      transport: new StdioClientTransport({
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
      }),
      oauth: null,
    };
  }

  const oauth = new McpOAuthProvider({
    serverId,
    redirectUrl: input.callbackUrl(),
    storage: input.storage(),
  });
  return {
    transport: new StreamableHTTPClientTransport(new URL(server.url), { authProvider: oauth }),
    oauth,
  };
}

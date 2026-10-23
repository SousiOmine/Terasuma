import type { Client, Tool as McpToolDefinition, Transport } from "@modelcontextprotocol/client";
import type { McpOAuthProvider } from "./oauth";

export type ServerConnection = {
  /** 接続を作ったときのサーバー設定（JSON）。変わったら作り直す。 */
  key: string;
  client: Client;
  /** 認可が必要になったときに URL を渡してくる口。stdio では null。 */
  oauth: McpOAuthProvider | null;
  /** サーバーが公開しているツール（名前空間を付ける前）。 */
  tools: readonly McpToolDefinition[];
};

/** 1 つのサーバーへ繋ぐための材料。 */
export type ConnectionMaterial = {
  transport: Transport;
  oauth: McpOAuthProvider | null;
};

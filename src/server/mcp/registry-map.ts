import type { McpServerStatusView } from "../../shared/api/settings";
import type { McpServersSettings } from "../data/settings";
import { toolNameFor } from "../../shared/tools";
import type { ServerConnection } from "./connection";
import { toolEntries, type McpToolset } from "./tools";
import type { ImageStore } from "../computer/images";

/**
 * つながっている MCP サーバーから、モデルへ渡すツール一式と、画面に出す状態を組み立てる。
 *
 * サーバーをまたいで同じツール名になると、モデルにも画面にもどちらのものか区別が付かない。
 * 名前が衝突したサーバーは「失敗」として理由を出し、そのサーバーのツールは渡さない。
 */

export type Rebuilt = {
  statuses: Map<string, McpServerStatusView>;
  tools: McpToolset;
};

export function rebuildRegistry(options: {
  servers: McpServersSettings;
  connections: Map<string, ServerConnection>;
  previous: Map<string, McpServerStatusView>;
  images: ImageStore;
}): Rebuilt {
  const { servers, connections, previous, images } = options;
  const claimed = new Map<string, string>();
  const conflicted = new Map<string, string>();
  for (const [serverId, connection] of connections) {
    for (const definition of connection.tools) {
      const namespaced = toolNameFor(serverId, definition.name);
      const owner = claimed.get(namespaced);
      if (owner === undefined) {
        claimed.set(namespaced, serverId);
      } else if (owner !== serverId) {
        conflicted.set(serverId, namespaced);
        conflicted.set(owner, namespaced);
      }
    }
  }

  const nextStatuses = new Map<string, McpServerStatusView>();
  const nextTools: McpToolset = {};

  for (const serverId of Object.keys(servers)) {
    const connection = connections.get(serverId);
    if (connection === undefined) {
      // 接続に失敗した理由は refresh() が書いている。まだ何も分からないサーバーは unknown。
      nextStatuses.set(serverId, previous.get(serverId) ?? { state: "unknown", tools: [], detail: null });
      continue;
    }

    const conflict = conflicted.get(serverId);
    if (conflict !== undefined) {
      nextStatuses.set(serverId, {
        state: "failed",
        tools: [],
        detail: `ツール名 ${conflict} が別のサーバーのツールと衝突しています（どちらかのサーバー名かツール名を変えてください）`,
      });
      continue;
    }

    nextStatuses.set(serverId, {
      state: "connected",
      tools: connection.tools.map((definition) => definition.name),
      detail: null,
    });
    for (const [namespaced, definition] of toolEntries(serverId, connection, images)) {
      nextTools[namespaced] = definition;
    }
  }

  return { statuses: nextStatuses, tools: nextTools };
}

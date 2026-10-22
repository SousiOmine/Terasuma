import { computerHandlers } from "./computer";
import { connectionHandlers } from "./connections";
import { containerHandlers } from "./container";
import { mcpHandlers } from "./mcp";
import { mediaHandlers } from "./media";
import { modelHandlers } from "./model";
import type { ApiDeps } from "./shared";
import { terasHandlers } from "./teras";
import { webSearchHandlers } from "./websearch";

/**
 * API のハンドラを 1 つにまとめる。
 * ルートの対応（どのメソッドがどのパスか）は http/server.ts が持つ。
 */
export function createApiHandlers(deps: ApiDeps) {
  return {
    ...terasHandlers(deps),
    ...modelHandlers(deps),
    ...mcpHandlers(deps),
    ...connectionHandlers(deps),
    ...webSearchHandlers(deps),
    ...containerHandlers(deps),
    ...computerHandlers(deps),
    ...mediaHandlers(deps),
  };
}

export type { ApiDeps, ApiRequest, ScreenRelayRequest } from "./shared";
export { SCREEN_RELAY_PREFIX } from "./shared";

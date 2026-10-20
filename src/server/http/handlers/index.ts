import { computerHandlers } from "./computer";
import { containerHandlers } from "./container";
import { mcpHandlers } from "./mcp";
import { modelHandlers } from "./model";
import type { ApiDeps } from "./shared";
import { terasHandlers } from "./teras";

/**
 * API のハンドラを 1 つにまとめる。
 * ルートの対応（どのメソッドがどのパスか）は http/server.ts が持つ。
 */
export function createApiHandlers(deps: ApiDeps) {
  return {
    ...terasHandlers(deps),
    ...modelHandlers(deps),
    ...mcpHandlers(deps),
    ...containerHandlers(deps),
    ...computerHandlers(deps),
  };
}

export type { ApiDeps, ApiRequest, ScreenRelayRequest } from "./shared";
export { SCREEN_RELAY_PREFIX } from "./shared";

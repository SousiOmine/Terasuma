import { computerHandlers } from "./computer";
import { connectionHandlers } from "./connections";
import { containerHandlers } from "./container";
import { discordHandlers } from "./discord";
import { mcpHandlers } from "./mcp";
import { mediaHandlers } from "./media";
import { modelHandlers } from "./model";
import type { ApiDeps } from "./shared";
import { terasHandlers } from "./teras";
import { webSearchHandlers } from "./websearch";

/**
 * API のハンドラを 1 つにまとめる。
 * ルートの対応（どのメソッドがどのパスか）は http/routes.ts が持つ。
 *
 * どのハンドラ名がどのモジュールから来るかを 1 か所にまとめておき、
 * ルート表との突き合わせ（tests/architecture.test.ts）が同じ一覧を使えるようにする。
 */
export const HANDLER_MODULES = {
  teras: terasHandlers,
  model: modelHandlers,
  mcp: mcpHandlers,
  connections: connectionHandlers,
  discord: discordHandlers,
  webSearch: webSearchHandlers,
  container: containerHandlers,
  computer: computerHandlers,
  media: mediaHandlers,
} as const;

export type ApiHandlers = ReturnType<typeof createApiHandlers>;

export function createApiHandlers(deps: ApiDeps) {
  return {
    ...HANDLER_MODULES.teras(deps),
    ...HANDLER_MODULES.model(deps),
    ...HANDLER_MODULES.mcp(deps),
    ...HANDLER_MODULES.connections(deps),
    ...HANDLER_MODULES.discord(deps),
    ...HANDLER_MODULES.webSearch(deps),
    ...HANDLER_MODULES.container(deps),
    ...HANDLER_MODULES.computer(deps),
    ...HANDLER_MODULES.media(deps),
  };
}

export type { ApiDeps, ApiRequest, ScreenRelayRequest } from "./shared";
export { SCREEN_RELAY_PREFIX } from "./shared";

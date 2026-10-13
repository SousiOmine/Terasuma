import index from "../client/index.html";
import type { AppConfig } from "../config";
import type { AgentEngine } from "./engine";
import { createApiHandlers } from "./routes";
import type { Store } from "./store";

export type ServerOptions = {
  config: AppConfig;
  store: Store;
  engine: AgentEngine;
};

/**
 * HTTP サーバを組み立てる。起動そのものは src/index.ts が行う。
 * ルートはここでリテラルのパスとして並べる（Bun のルータは文字列リテラルからパラメータ型を作る）。
 */
export function createServer(options: ServerOptions) {
  const { config, store, engine } = options;
  const api = createApiHandlers({ store, engine });

  return Bun.serve({
    hostname: config.host,
    port: config.port,
    development: config.isDevelopment,
    routes: {
      "/": index,
      "/api/sessions": {
        GET: api.listSessions,
      },
      "/api/sessions/:id": {
        PATCH: api.renameSession,
        DELETE: api.deleteSession,
      },
      "/api/sessions/:id/messages": {
        GET: api.listMessages,
        POST: api.sendMessage,
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });
}

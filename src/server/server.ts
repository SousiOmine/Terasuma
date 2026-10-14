import index from "../client/index.html";
import type { AppConfig } from "../config";
import type { AgentEngine } from "./engine";
import { createProviderModelLister, type ProviderModelLister } from "./provider-models";
import { createApiHandlers } from "./routes";
import type { SettingsStore } from "./settings";
import type { Store } from "./store";

export type ServerOptions = {
  config: AppConfig;
  store: Store;
  engine: AgentEngine;
  /** モデルとプロバイダの設定。 */
  settings: SettingsStore;
  /** プロバイダのモデル一覧を取ってくる関数。テストで差し替える。 */
  listModels?: ProviderModelLister;
};

/**
 * HTTP サーバを組み立てる。起動そのものは src/index.ts が行う。
 * ルートはここでリテラルのパスとして並べる（Bun のルータは文字列リテラルからパラメータ型を作る）。
 */
export function createServer(options: ServerOptions) {
  const { config, store, engine, settings } = options;
  const api = createApiHandlers({
    store,
    engine,
    settings,
    listModels: options.listModels ?? createProviderModelLister(),
  });

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
      "/api/model": {
        GET: api.readModelSettings,
        PUT: api.setDefaultModel,
      },
      "/api/model/check": {
        POST: api.checkProvider,
      },
      "/api/model/providers": {
        POST: api.addProvider,
      },
      "/api/model/providers/:id": {
        PATCH: api.updateProvider,
        DELETE: api.removeProvider,
      },
      "/api/model/providers/:id/models": {
        GET: api.listProviderModels,
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });
}

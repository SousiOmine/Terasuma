import type { Server } from "bun";
import index from "../client/index.html";
import type { AppConfig } from "../config";
import type { AgentEngine } from "./engine";
import { describeError } from "./errors";
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

/** 起動したサーバと、ポートをどう確保したか。 */
export type StartedServer = {
  /** 起動したサーバ。待ち受けているポートは server.port にある（WebSocket は使わないので undefined）。 */
  server: Server<undefined>;
  /** 設定したポートが埋まっていたため、OS に選ばせた別のポートで起動したかどうか。 */
  portChanged: boolean;
};

/**
 * ポートを OS に選ばせるための値（Bun.serve の port に渡す）。
 * 設定したポートが埋まっていたときの逃げ道としてだけ使う。
 */
const ANY_FREE_PORT = 0;

/**
 * HTTP サーバを起動する。設定したポートが埋まっていたら、空いているポートを OS に選ばせて起動する。
 *
 * ルートはここでリテラルのパスとして並べる（Bun のルータは文字列リテラルからパラメータ型を作る）。
 */
export function startServer(options: ServerOptions): StartedServer {
  const { config, store, engine, settings } = options;
  const api = createApiHandlers({
    store,
    engine,
    settings,
    listModels: options.listModels ?? createProviderModelLister(),
  });

  const serve = (port: number) =>
    Bun.serve({
      hostname: config.host,
      port,
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

  return serveOnAvailablePort(config.port, serve);
}

/**
 * 希望のポートで listen する。埋まっていたら OS に空きポートを選ばせて listen し直す。
 * どのポートで起動できたかは戻り値で伝える（呼び出し側が開く URL を知らせられるように）。
 */
function serveOnAvailablePort(preferredPort: number, serve: (port: number) => Server<undefined>): StartedServer {
  try {
    return { server: serve(preferredPort), portChanged: false };
  } catch (error) {
    // ポートが埋まっている以外の失敗は、握り潰さずに起動を止める。
    if (!isAddressInUse(error)) throw error;
  }

  try {
    return { server: serve(ANY_FREE_PORT), portChanged: true };
  } catch (error) {
    // 取り合いになっても、設定したポートが使えなかったことは分かるようにしておく。
    throw new Error(`空きポートでも起動できませんでした（${preferredPort} が使用中です）: ${describeError(error)}`, {
      cause: error,
    });
  }
}

/** listen が「使用中のポート」で失敗したかどうか。Bun はそのとき code に EADDRINUSE を入れる。 */
function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

import type { Server } from "bun";
import { join } from "node:path";
import type { AppConfig } from "../../config";
import type { ContainerManager } from "../computer/container";
import type { EnvRequests } from "../computer/env";
import type { FileStore } from "../computer/files";
import type { ImageStore } from "../computer/images";
import { MAX_REQUEST_BODY_BYTES } from "../computer/uploads";
import type { AgentEngine } from "../agent/engine";
import type { Handover } from "../computer/handover";
import { describeError } from "../../shared/errors";
import { jsonError, withErrorHandling } from "./respond";
import type { ConnectionsManager } from "../connections/manager";
import type { McpManager } from "../mcp/manager";
import type { WebSearchManager } from "../websearch-manager";
import type { Compaction } from "../agent/compaction";
import { CATALOG_FILE_NAME, createCatalog, type Catalog } from "../provider/catalog";
import {
  createConnectionChecker,
  createModelLister,
  type ConnectionChecker,
  type ProviderModelLister,
} from "../provider/connection";
import { createApiHandlers } from "./handlers";
import type { SettingsStore } from "../data/settings";
import type { Store } from "../data/store";
import { createRoutes } from "./routes";
import { routeProblem } from "./route-problem";
import { createScreenSocket, type ScreenSocketData } from "./screen-socket";

export type ServerOptions = {
  config: AppConfig;
  store: Store;
  engine: AgentEngine;
  /** モデルとプロバイダの設定。 */
  settings: SettingsStore;
  /** MCP サーバーとの接続。OAuth のコールバックもここを通る。 */
  mcp: McpManager;
  /** アプリの接続（OAuth）。設定画面とチャットのカードからの操作もここを通る。 */
  connections: ConnectionsManager;
  /** Web 検索の設定と接続確認。設定画面からの操作もここを通る。 */
  webSearch: WebSearchManager;
  /** podman で動かすコンテナ。設定画面からの操作もここを通る。 */
  container: ContainerManager;
  /** エージェントが送った画像。画面へ返す。 */
  images: ImageStore;
  /** エージェントが送ったファイル。画面へ返す。 */
  files: FileStore;
  /** ユーザーへ画面を渡す待ち。 */
  handover: Handover;
  /** 環境変数の入力待ち。チャットで入力された値を設定へ書く。 */
  envRequests: EnvRequests;
  /** 過去の対話の圧縮（古いやり取りの畳み方）。テストで差し替える。 */
  compaction: Compaction;
  /** models.dev のカタログ。テストで差し替える。 */
  catalog?: Catalog;
  /** プロバイダへ接続できるかの確認。テストで差し替える。 */
  checkConnection?: ConnectionChecker;
  /** 独自エンドポイントのモデル一覧。テストで差し替える。 */
  listModels?: ProviderModelLister;
};

/** 起動したサーバと、ポートをどう確保したか。 */
export type StartedServer = {
  /** 起動したサーバ。待ち受けているポートは server.port にある。 */
  server: Server<ScreenSocketData>;
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
 * ルートの対応は routes.ts が持つ。ここは依存を組み立てて、Bun.serve に渡すだけにする。
 */
export function startServer(options: ServerOptions): StartedServer {
  const {
    config,
    store,
    engine,
    compaction,
    settings,
    mcp,
    connections,
    webSearch,
    container,
    images,
    files,
    handover,
    envRequests,
  } = options;
  // 各ハンドラの例外は、ここで 1 度だけ応答に変える（ハンドラ側に try/catch を書かない）。
  const api = withErrorHandling(
    createApiHandlers({
      store,
      engine,
      settings,
      mcp,
      connections,
      webSearch,
      container,
      images,
      files,
      handover,
      envRequests,
      compaction,
      catalog: options.catalog ?? createCatalog({ cachePath: join(config.dataDir, CATALOG_FILE_NAME) }),
      checkConnection: options.checkConnection ?? createConnectionChecker(),
      listModels: options.listModels ?? createModelLister(),
    }),
  );
  const screen = createScreenSocket(container);
  const routes = createRoutes(api, screen);

  const serve = (port: number) =>
    Bun.serve<ScreenSocketData>({
      hostname: config.host,
      port,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      development: config.isDevelopment,
      routes,
      websocket: screen.websocket,
      fetch(request) {
        const problem = routeProblem(routes, new URL(request.url).pathname, request.method);
        return problem === "method_not_allowed" ? jsonError(405, "method_not_allowed") : jsonError(404, "not_found");
      },
      /**
       * ハンドラから漏れた例外も、ほかの失敗と同じ JSON で返す。
       * Bun の既定のエラーページは HTML なので、画面はコードから文言を選べず、
       * 理由も「HTTP 500」しか分からなくなる。
       */
      error(error: Error): Response {
        console.error(error);
        return jsonError(500, "internal_error", describeError(error));
      },
    });

  return serveOnAvailablePort(config.port, serve, config.isDevelopment);
}

/**
 * 希望のポートで listen する。
 *
 * 開発時だけ、埋まっていたら OS に空きポートを選ばせて listen し直す（手元で 2 つ目を動かせる）。
 * 本番は設定したポートで待つ。Tailscale Serve や SSH トンネルは既定のポートを前提にしているので、
 * 黙って別のポートへ移ると、画面が開かない理由が分からなくなる。
 * どのポートで起動できたかは戻り値で伝える（呼び出し側が開く URL を知らせられるように）。
 */
function serveOnAvailablePort(
  preferredPort: number,
  serve: (port: number) => Server<ScreenSocketData>,
  allowPortFallback: boolean,
): StartedServer {
  try {
    return { server: serve(preferredPort), portChanged: false };
  } catch (error) {
    // ポートが埋まっている以外の失敗は、握り潰さずに起動を止める。
    if (!isAddressInUse(error)) throw error;
    if (!allowPortFallback) {
      throw new Error(
        `${preferredPort} は使用中です。設定したポートで起動できませんでした（開発時は空いているポートで起動します）`,
        { cause: error },
      );
    }
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

import type { Server } from "bun";
import { join } from "node:path";
import index from "../client/index.html";
import type { AppConfig } from "../config";
import { type ContainerManager } from "./container";
import type { AgentEngine } from "./engine";
import type { Handover } from "./handover";
import type { ImageStore } from "./images";
import { describeError } from "./errors";
import type { McpManager } from "./mcp";
import { OAUTH_CALLBACK_PATH } from "./mcp-oauth";
import { CATALOG_FILE_NAME, createCatalog, type Catalog } from "./models-dev";
import {
  createConnectionChecker,
  createModelLister,
  type ConnectionChecker,
  type ProviderModelLister,
} from "./provider-models";
import { createApiHandlers } from "./routes";
import type { SettingsStore } from "./settings";
import type { Store } from "./store";

export type ServerOptions = {
  config: AppConfig;
  store: Store;
  engine: AgentEngine;
  /** モデルとプロバイダの設定。 */
  settings: SettingsStore;
  /** MCP サーバーとの接続。OAuth のコールバックもここを通る。 */
  mcp: McpManager;
  /** podman で動かすコンテナ。設定画面からの操作もここを通る。 */
  container: ContainerManager;
  /** ツールが撮った画像の置き場。配信もここから行う。 */
  images: ImageStore;
  /** ユーザーへ画面を渡す待ち。 */
  handover: Handover;
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
 * 画面の WebSocket 中継で、ブラウザ 1 つとコンテナを結ぶ分。
 * noVNC はバイナリで RFB を話すので、そのまま転送する。
 */
type ScreenSocketData = {
  /** 中継先のコンテナのポート。接続した時点の値。 */
  vncPort: number;
  /** コンテナ側の socket。繋がるまでは null。 */
  upstream: WebSocket | null;
  /** 繋がる前にブラウザから届いた分。順番を保って送るために貯める。 */
  queue: (string | Uint8Array)[];
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
  const { config, store, engine, settings, mcp, container, images, handover } = options;
  const api = createApiHandlers({
    store,
    engine,
    settings,
    mcp,
    container,
    images,
    handover,
    catalog: options.catalog ?? createCatalog({ cachePath: join(config.dataDir, CATALOG_FILE_NAME) }),
    checkConnection: options.checkConnection ?? createConnectionChecker(),
    listModels: options.listModels ?? createModelLister(),
  });

  const serve = (port: number) =>
    Bun.serve<ScreenSocketData>({
      hostname: config.host,
      port,
      development: config.isDevelopment,
      routes: {
        "/": index,
        "/api/sessions": {
          GET: api.listSessions,
        },
        "/api/sessions/:id": {
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
        "/api/model/reasoning": {
          GET: api.readReasoning,
          PUT: api.setReasoning,
        },
        "/api/model/catalog": {
          GET: api.listCatalogProviders,
        },
        "/api/model/catalog/:id/models": {
          GET: api.listCatalogModels,
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
        "/api/mcp/servers": {
          GET: api.listMcpServers,
          POST: api.addMcpServer,
        },
        // 追加の前に、入力された設定で繋がるかを確かめる（設定には書かない）。
        "/api/mcp/test": {
          POST: api.testMcpServer,
        },
        "/api/mcp/servers/:id": {
          PATCH: api.updateMcpServer,
          DELETE: api.removeMcpServer,
        },
        "/api/mcp/servers/:id/check": {
          POST: api.checkMcpServer,
        },
        "/api/mcp/servers/:id/authorize": {
          POST: api.authorizeMcpServer,
          DELETE: api.cancelMcpAuthorization,
        },
        // ツールが撮った画像。中身がハッシュで決まるので、URL ごと長くキャッシュさせてよい。
        "/api/images/:sha256": {
          GET: api.readImage,
        },
        "/api/container": {
          GET: api.readContainer,
        },
        "/api/container/start": {
          POST: api.startContainer,
        },
        "/api/container/reset": {
          POST: api.resetContainer,
        },
        // 画面の中継。noVNC の HTML と JS をコンテナから取ってきて返す。
        "/api/computer/screen/*": {
          GET: api.relayScreen,
        },
        // 画面の操作。ブラウザと、コンテナの中の x11vnc を繋ぐ。
        // 引き受け（画面を渡している間）の返事。
        "/api/computer/handover": {
          POST: api.answerHandover,
        },
        "/api/computer/vnc": {
          GET: async (req: Request, server: Server<ScreenSocketData>) => {
            const status = await container.status();
            if (status.state !== "running" || status.vncPort === null) {
              return new Response("コンピュータが動いていないため、画面を表示できません", { status: 409 });
            }

            const upgraded = server.upgrade(req, {
              data: { vncPort: status.vncPort, upstream: null, queue: [] },
            });
            // 切り替えに成功した場合、Bun はこの戻り値を使わない（undefined を返す）。
            return upgraded ? undefined : new Response("WebSocket に切り替えられませんでした", { status: 400 });
          },
        },
        // 認可のコールバックは、OAuth 側が組み立てる URL（OAUTH_CALLBACK_PATH）と同じパスに置く。
        [OAUTH_CALLBACK_PATH]: {
          GET: api.mcpOAuthCallback,
        },
      },
      websocket: {
        open(ws) {
          const upstream = new WebSocket(`ws://127.0.0.1:${ws.data.vncPort}/websockify`);
          upstream.binaryType = "arraybuffer";

          upstream.onopen = () => {
            ws.data.upstream = upstream;
            // 繋がる前にブラウザから届いた分を、順番のまま送る。
            for (const item of ws.data.queue) upstream.send(item);
            ws.data.queue.length = 0;
          };
          upstream.onmessage = (event) => {
            ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
          };
          // コンテナ側が切れたらブラウザ側も切る（繋がっているように見せない）。
          upstream.onclose = () => ws.close();
          upstream.onerror = () => ws.close();
        },
        message(ws, message) {
          if (ws.data.upstream === null) {
            // 最初の挨拶を落とすと繋がらないので、繋がるまで貯める。
            ws.data.queue.push(typeof message === "string" ? message : new Uint8Array(message));
            return;
          }
          ws.data.upstream.send(message);
        },
        close(ws) {
          const upstream = ws.data.upstream;
          ws.data.upstream = null;
          upstream?.close();
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
function serveOnAvailablePort(
  preferredPort: number,
  serve: (port: number) => Server<ScreenSocketData>,
): StartedServer {
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

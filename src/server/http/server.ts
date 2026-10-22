import type { Server } from "bun";
import { join } from "node:path";
import index from "../../client/index.html";
import type { AppConfig } from "../../config";
import type { ContainerManager } from "../computer/container";
import type { FileStore } from "../computer/files";
import type { ImageStore } from "../computer/images";
import { MAX_REQUEST_BODY_BYTES } from "../computer/uploads";
import type { AgentEngine } from "../agent/engine";
import type { Handover } from "../computer/handover";
import { describeError } from "../../shared/errors";
import { jsonError, withErrorHandling } from "./respond";
import type { McpManager } from "../mcp/manager";
import { OAUTH_CALLBACK_PATH } from "../mcp/oauth";
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

export type ServerOptions = {
  config: AppConfig;
  store: Store;
  engine: AgentEngine;
  /** モデルとプロバイダの設定。 */
  settings: SettingsStore;
  /** MCP サーバーとの接続。OAuth のコールバックもここを通る。 */
  mcp: McpManager;
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
  const { config, store, engine, compaction, settings, mcp, webSearch, container, images, files, handover } = options;
  // 各ハンドラの例外は、ここで 1 度だけ応答に変える（ハンドラ側に try/catch を書かない）。
  const api = withErrorHandling(
    createApiHandlers({
      store,
      engine,
      settings,
      mcp,
      webSearch,
      container,
      images,
      files,
      handover,
      compaction,
      catalog: options.catalog ?? createCatalog({ cachePath: join(config.dataDir, CATALOG_FILE_NAME) }),
      checkConnection: options.checkConnection ?? createConnectionChecker(),
      listModels: options.listModels ?? createModelLister(),
    }),
  );

  const serve = (port: number) =>
    Bun.serve<ScreenSocketData>({
      hostname: config.host,
      port,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      development: config.isDevelopment,
      routes: {
        "/": index,
        // Tera（会話の持ち主）と、その 1 本の履歴。
        "/api/teras": {
          GET: api.listTeras,
        },
        "/api/teras/:id/messages": {
          GET: api.listMessages,
          POST: api.sendMessage,
        },
        // 生成中のターンを、ここで打ち切る（それまでの本文や添付は保存される）。
        "/api/teras/:id/stop": {
          POST: api.stopTurn,
        },
        // エージェントが送った画像・ファイル。URL は中身のハッシュから決まる。
        "/api/images/:file": {
          GET: api.readImage,
        },
        "/api/files/:id": {
          GET: api.readFile,
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
        // Web 検索のプロバイダ。保存前の確認は接続先へ 1 回検索を投げる。
        "/api/websearch": {
          GET: api.readWebSearch,
        },
        "/api/websearch/test": {
          POST: api.testWebSearchProvider,
        },
        "/api/websearch/providers": {
          POST: api.addWebSearchProvider,
        },
        "/api/websearch/providers/:id": {
          PATCH: api.updateWebSearchProvider,
          DELETE: api.removeWebSearchProvider,
        },
        "/api/websearch/default": {
          PUT: api.setDefaultWebSearchProvider,
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

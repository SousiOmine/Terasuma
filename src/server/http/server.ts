import type { Server } from "bun";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "../../config";
import { MAX_REQUEST_BODY_BYTES } from "../computer/uploads";
import { describeError } from "../../shared/errors";
import { jsonError, withErrorHandling } from "./respond";
import { createApiHandlers, type ApiDeps } from "./handlers";
import { createRoutes } from "./routes";
import { routeProblem } from "./route-problem";
import { createScreenSocket, type ScreenSocketData } from "./screen-socket";

/**
 * 起動に必要なもの。依存は app.ts が組み立てたものをそのまま受け取る。
 * ここで作るのは、起動するまで決まらない VNC のトークンだけにする。
 */
export type ServerOptions = {
  config: AppConfig;
  deps: Omit<ApiDeps, "vncToken">;
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
 * ルートの対応は routes.ts が持つ。ここは依存を受け取って、Bun.serve に渡すだけにする。
 */
export function startServer(options: ServerOptions): StartedServer {
  const { config, deps } = options;

  // 画面の WebSocket は、この起動でだけ使えるトークンで開く。
  // WebSocket は CORS の制約を受けないので、トークンが無いと他サイトから画面を操作できてしまう。
  const vncToken = randomBytes(32).toString("hex");

  // 各ハンドラの例外は、ここで 1 度だけ応答に変える（ハンドラ側に try/catch を書かない）。
  const api = withErrorHandling(createApiHandlers({ ...deps, vncToken }));
  const screen = createScreenSocket(deps.container, vncToken);
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

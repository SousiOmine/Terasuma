import type { Server, WebSocketHandler } from "bun";
import { timingSafeEqual } from "node:crypto";
import { screenTokenFromProtocols } from "../../shared/screen";
import type { ContainerManager } from "../computer/container";
import { jsonError } from "./respond";

/** 中継が繋がるまでに貯めるメッセージの上限。 */
const MAX_QUEUED_MESSAGES = 100;

/**
 * 画面の WebSocket 中継で、ブラウザ 1 つとコンテナを結ぶ分。
 * noVNC はバイナリで RFB を話すので、そのまま転送する。
 */
export type ScreenSocketData = {
  /** 中継先のコンテナのポート。接続した時点の値。 */
  vncPort: number;
  /** コンテナ側の socket。繋がるまでは null。 */
  upstream: WebSocket | null;
  /** 繋がる前にブラウザから届いた分。順番を保って送るために貯める。 */
  queue: (string | Uint8Array)[];
};

/** 画面の WebSocket 中継。ルートの upgrade と、Bun.serve の websocket を 1 つにまとめる。 */
export type ScreenSocket = {
  upgrade(req: Request, server: Server<ScreenSocketData>): Promise<Response | undefined>;
  websocket: WebSocketHandler<ScreenSocketData>;
};

export function createScreenSocket(container: ContainerManager, vncToken: string): ScreenSocket {
  return {
    async upgrade(req, server) {
      // WebSocket は CORS の制約を受けない。トークンを知らない画面（他サイト）は開けない。
      // Tailscale（serve / funnel）はアップグレード要求からクエリを落とすため、
      // 直接 localhost で開く場合のクエリと、中継を通る場合のヘッダの両方を受け付ける。
      const url = new URL(req.url);
      const provided =
        url.searchParams.get("token") ?? screenTokenFromProtocols(req.headers.get("sec-websocket-protocol"));
      if (!sameToken(provided, vncToken)) {
        return jsonError("unauthorized", "画面のトークンが違います");
      }

      const status = await container.status();
      if (status.state !== "running" || status.vncPort === null) {
        return jsonError("container_not_running", "コンピュータが動いていないため、画面を表示できません");
      }

      const upgraded = server.upgrade(req, {
        data: { vncPort: status.vncPort, upstream: null, queue: [] },
      });
      // 切り替えに成功した場合、Bun はこの戻り値を使わない（undefined を返す）。
      return upgraded ? undefined : jsonError("invalid_request", "WebSocket に切り替えられませんでした");
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
        upstream.onclose = (event) => {
          console.warn("[screen] upstream closed", event.code, event.reason);
          ws.close();
        };
        upstream.onerror = () => {
          console.warn("[screen] upstream error");
          ws.close();
        };
      },
      message(ws, message) {
        if (ws.data.upstream === null) {
          // 最初の挨拶を落とすと繋がらないので、繋がるまで貯める。
          // 繋がらないまま溜まり続けると、こちらが抱える分が際限なくなるので、上限で切る。
          if (ws.data.queue.length >= MAX_QUEUED_MESSAGES) {
            console.warn("[screen] dropped a message: the relay did not connect in time");
            ws.close();
            return;
          }
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
  };
}

/** トークンを定数時間で比べる（長さが違えば、その時点で違う）。 */
function sameToken(provided: string | null, expected: string): boolean {
  if (provided === null || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
}

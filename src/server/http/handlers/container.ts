import { describeError } from "../../../shared/errors";
import { readJsonBody } from "../body";
import { json, jsonError } from "../respond";
import { type ApiDeps, type ApiRequest, SCREEN_RELAY_PREFIX, type ScreenRelayRequest } from "./shared";

/**
 * podman で動かすコンテナと、その画面の中継。
 */
export function containerHandlers(deps: ApiDeps) {
  return {
    /** コンテナのいまの状態。設定画面とチャット画面がこれを見て案内を出す。 */
    async readContainer(): Promise<Response> {
      return json(await deps.container.status());
    },

    /** コンテナを起動する。イメージが無ければ作り、コンテナが無ければ作るところまで行う。 */
    async startContainer(): Promise<Response> {
      return json(await deps.container.start());
    },

    /** コンテナを作り直す。wipeHome を選んだときだけ、マウントしたフォルダの中身も消す。 */
    async resetContainer(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      return json(await deps.container.reset({ wipeHome: body?.["wipeHome"] === true }));
    },

    /**
     * 画面の中継。コンテナの noVNC（websockify が配る HTML と JS）を Terasuma の待ち受けから返す。
     *
     * ブラウザへ見せる待ち受けを Terasuma の 1 つに保つため、コンテナのポートは直接見せない。
     * LAN へ公開したときのトークン認証も、この 1 か所に掛けられる。
     */
    async relayScreen(req: ScreenRelayRequest): Promise<Response> {
      const status = await deps.container.status();
      if (status.state !== "running" || status.vncPort === null) {
        return jsonError(409, "container_not_running", "コンピュータが動いていないため、画面を表示できません");
      }

      const incoming = new URL(req.url);
      // 中継の接頭辞を落として、コンテナのルートからのパスにする。問い合わせはそのまま渡す。
      const path = incoming.pathname.slice(SCREEN_RELAY_PREFIX.length);

      let upstream: Response;
      try {
        upstream = await fetch(`http://127.0.0.1:${status.vncPort}/${path}${incoming.search}`, {
          signal: req.signal,
        });
      } catch (error) {
        return jsonError(502, "container_not_running", `画面を取れませんでした: ${describeError(error)}`);
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
          // noVNC の JS は頻繁には変わらないが、古いものが残ると原因が分かりにくい。
          "Cache-Control": "no-store",
        },
      });
    },
  };
}

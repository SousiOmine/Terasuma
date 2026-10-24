import { readJsonBody } from "../body";
import { json } from "../respond";
import type { ApiDeps, ApiRequest } from "./shared";

/**
 * podman で動かすコンテナ。
 *
 * 画面（noVNC）の JS はアプリのバンドルに同梱し、コンテナからは配らない。
 * WebSocket の中継は screen-socket.ts が持つ。
 */
export function containerHandlers(deps: Pick<ApiDeps, "container">) {
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
  };
}

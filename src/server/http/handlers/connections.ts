import { describeError } from "../../../shared/errors";
import type { ConnectionAuthorizationView } from "../../../shared/types";
import { AppError } from "../../errors";
import { readConnectionForm } from "../body";
import { json } from "../respond";
import type { ApiDeps, ApiRequest } from "./shared";

/**
 * アプリの接続の設定。
 *
 * 一覧はトークンを返さず、接続中のアカウントと進行中の認可だけを返す。
 * 認可の開始は設定画面とチャットのカードの両方から呼ばれる。進行中なら同じコードを
 * 返すのは manager の役目なので、ここでは id の確認と HTTP への変換だけを行う。
 */
export function connectionHandlers(deps: ApiDeps) {
  const { connections } = deps;

  /** 知らない接続 id はここで 404 にする。 */
  function requireConnection(id: string): void {
    connections.provider(id);
  }

  return {
    /** 接続の一覧（設定と、いま分かっている状態）。 */
    listConnections(): Response {
      return json(connections.view());
    },

    /** Client ID を保存する。null で設定ごと消す。 */
    async setConnection(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      requireConnection(id);

      const form = await readConnectionForm(req);
      return json(connections.setClientId(id, form.clientId));
    },

    /**
     * 認可を始める。進行中なら同じコードが返り、接続済みなら flow は null。
     * 認可そのものはブラウザの別タブで進むので、ここではコードを返して待たない。
     */
    async authorizeConnection(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      requireConnection(id);

      try {
        const flow = await connections.start(id);
        return json({ flow } satisfies ConnectionAuthorizationView);
      } catch (error) {
        // 設定の誤り（Client ID 未設定）はそのまま返し、接続先の失敗は 502 にする。
        if (error instanceof AppError) throw error;
        throw new AppError("connection_authorization_failed", 502, describeError(error));
      }
    },

    /** 進行中の認可を止める。 */
    cancelConnection(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      requireConnection(id);

      connections.cancel(id);
      return json(connections.view());
    },

    /** 保存されている認可を消す。 */
    disconnectConnection(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      requireConnection(id);

      return json(connections.disconnect(id));
    },
  };
}

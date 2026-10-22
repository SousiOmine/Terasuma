import { describeError } from "../../../shared/errors";
import { AppError, ValidationError } from "../../errors";
import { readConnectionClientIdForm, readConnectionTokenForm } from "../body";
import { json } from "../respond";
import type { ApiDeps, ApiRequest } from "./shared";

/**
 * アプリの接続の設定。
 *
 * 一覧はトークンを返さず、接続中のアカウントと Application ID だけを返す。
 * 接続はトークンを貼るだけなので、認可の開始・中止は無い。
 * チャットのカードが待ちをやめるときだけ、wait を止める。
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

    /** Application ID を保存する（Discord の招待リンクに使う）。null で設定ごと消す。 */
    async setConnectionClientId(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      requireConnection(id);

      const form = await readConnectionClientIdForm(req);
      return json(connections.setClientId(id, form.clientId));
    },

    /**
     * トークンを保存する。
     * 保存する前にアカウントを読んで確かめる。受け付けられないトークンは保存しない。
     */
    async setConnectionToken(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      requireConnection(id);

      const form = await readConnectionTokenForm(req);
      try {
        return json(await connections.setToken(id, form.token));
      } catch (error) {
        if (error instanceof AppError) throw error;
        // 受け付けられないトークン・接続先に届かない、は入力の誤りとして返す。
        throw new ValidationError(describeError(error));
      }
    },

    /** チャットのカードが、トークンの保存待ちをやめる。 */
    cancelConnectionWait(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      requireConnection(id);

      connections.cancelWait(id);
      return json(connections.view());
    },

    /** 保存されているトークンを消す。 */
    disconnectConnection(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      requireConnection(id);

      return json(connections.disconnect(id));
    },
  };
}

import { describeError } from "../../../shared/errors";
import { AppError, ValidationError } from "../../errors";
import { readConnectionTokenForm } from "../body";
import { json } from "../respond";
import type { ApiDeps, ApiRequest } from "./shared";

/**
 * アプリの接続の設定。
 *
 * 一覧はトークンを返さず、接続中のアカウントだけを返す。
 * 接続はトークンを貼るだけなので、認可の開始・中止は無い。
 * チャットのカードが待ちをやめるときだけ、wait を止める。
 */
export function connectionHandlers(deps: Pick<ApiDeps, "connections">) {
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

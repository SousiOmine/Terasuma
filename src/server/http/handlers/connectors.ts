import { describeError } from "../../../shared/errors";
import { AppError, ValidationError } from "../../errors";
import { readConnectorTokenForm } from "../body";
import { json } from "../respond";
import type { ApiDeps, ApiRequest } from "./shared";

/**
 * コネクタの設定。
 *
 * 一覧はトークンを返さず、接続中のアカウントだけを返す。
 * コネクタはトークンを貼るだけなので、認可の開始・中止は無い。
 * チャットのカードが待ちをやめるときだけ、wait を止める。
 */
export function connectorHandlers(deps: Pick<ApiDeps, "connectors">) {
  const { connectors } = deps;

  /** 知らないコネクタ id はここで 404 にする。 */
  function requireConnector(id: string): void {
    connectors.provider(id);
  }

  return {
    /** コネクタの一覧（設定と、いま分かっている状態）。 */
    listConnectors(): Response {
      return json(connectors.view());
    },

    /**
     * トークンを保存する。
     * 保存する前にアカウントを読んで確かめる。受け付けられないトークンは保存しない。
     */
    async setConnectorToken(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      requireConnector(id);

      const form = await readConnectorTokenForm(req);
      try {
        return json(await connectors.setToken(id, form.token));
      } catch (error) {
        if (error instanceof AppError) throw error;
        // 受け付けられないトークン・接続先に届かない、は入力の誤りとして返す。
        throw new ValidationError(describeError(error));
      }
    },

    /** チャットのカードが、トークンの保存待ちをやめる。 */
    cancelConnectorWait(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      requireConnector(id);

      connectors.cancelWait(id);
      return json(connectors.view());
    },

    /** 保存されているトークンを消す。 */
    disconnectConnector(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      requireConnector(id);

      return json(connectors.disconnect(id));
    },
  };
}

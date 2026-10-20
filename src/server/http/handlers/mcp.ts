import { describeError } from "../../../shared/errors";
import type { McpAuthorizationView } from "../../../shared/types";
import { AppError, SettingsWriteError, ValidationError } from "../../errors";
import { readMcpForm } from "../body";
import { json } from "../respond";
import { authorizationPage, toMcpView } from "../views";
import { type ApiDeps, type ApiRequest, requireMcpServer } from "./shared";

/**
 * MCP サーバーの設定と接続。
 *
 * 一覧を開いただけでは繋ぎに行かない。接続を確かめるのは、
 * 「接続を確認」を押したときと、保存した直後だけ。
 */
export function mcpHandlers(deps: ApiDeps) {
  const { settings } = deps;

  /** MCP の設定を書き換えて、書き換えた後の全体を返す。 */
  function commit(change: () => void): Response {
    try {
      change();
    } catch (error) {
      throw new SettingsWriteError(describeError(error), error);
    }
    return json(toMcpView(settings.read().mcpServers, deps.mcp));
  }

  return {
    /** MCP サーバーの一覧（設定と、いま分かっている接続状態）。 */
    listMcpServers(): Response {
      return json(toMcpView(settings.read().mcpServers, deps.mcp));
    },

    /**
     * MCP サーバーを追加する。繋がるかどうかは画面が確かめてからここへ来る
     * （同じ接続を 2 度試さないよう、ここでは確かめ直さない）。
     */
    async addMcpServer(req: ApiRequest): Promise<Response> {
      const parsed = await readMcpForm(req);

      if (settings.read().mcpServers[parsed.id] !== undefined) {
        throw new AppError("mcp_server_exists", 409, `MCP サーバー ${parsed.id} はすでに追加されています`);
      }

      return commit(() => settings.putMcpServer(parsed.id, parsed.server));
    },

    /**
     * 保存する前に、入力された設定で繋がるか確かめる。設定には何も書かない。
     * サーバーが認可を求めた場合は、ブラウザで開く URL を返して認可を待つ。
     */
    async testMcpServer(req: ApiRequest): Promise<Response> {
      const parsed = await readMcpForm(req);
      return json(await deps.mcp.test(parsed.id, parsed.server));
    },

    /** MCP サーバーの設定を変える。接続は次に確かめたときから新しい設定になる。 */
    async updateMcpServer(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      requireMcpServer(settings, id);

      const parsed = await readMcpForm(req);
      if (parsed.id !== id) throw new ValidationError(`id は URL の ${id} と同じにしてください`);

      return commit(() => settings.putMcpServer(id, parsed.server));
    },

    removeMcpServer(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      requireMcpServer(settings, id);

      deps.mcp.cancelAuthorization(id);
      return commit(() => void settings.deleteMcpServer(id));
    },

    /** 接続を確かめ、公開されているツールを返す。 */
    async checkMcpServer(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      requireMcpServer(settings, id);
      return json(await deps.mcp.check(id));
    },

    /** OAuth の認可を始める。ブラウザで開く URL を返す。 */
    async authorizeMcpServer(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      requireMcpServer(settings, id);

      try {
        const result = await deps.mcp.authorize(id);
        return json({ url: result.url } satisfies McpAuthorizationView);
      } catch (error) {
        // 認可を始められなかった理由は、接続先の問題として返す（設定の誤りではない）。
        if (error instanceof AppError) throw error;
        throw new AppError("mcp_authorization_failed", 502, describeError(error));
      }
    },

    /** 待っている認可を取り消す。 */
    cancelMcpAuthorization(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      requireMcpServer(settings, id);

      deps.mcp.cancelAuthorization(id);
      return json(toMcpView(settings.read().mcpServers, deps.mcp));
    },

    /**
     * OAuth のリダイレクト先。ブラウザが直接開くため、JSON ではなく読める 1 枚のページを返す。
     * 成否はサーバーのログではなくここに出し、設定画面は接続を確かめ直して状態を拾う。
     */
    async mcpOAuthCallback(request: { url: string }): Promise<Response> {
      const url = new URL(request.url);
      const state = url.searchParams.get("state");
      if (state === null) {
        return authorizationPage(400, "認可を確認できませんでした", [
          "URL に state がありません。",
          "Invalid callback: missing state.",
        ]);
      }

      try {
        await deps.mcp.completeAuthorization(state, {
          code: url.searchParams.get("code"),
          iss: url.searchParams.get("iss"),
          error: url.searchParams.get("error"),
        });
      } catch (error) {
        return authorizationPage(400, "認可できませんでした", [
          describeError(error),
          "設定画面の「認可する」からやり直してください。",
          "Authorization failed. Start it again from Settings.",
        ]);
      }

      return authorizationPage(200, "認可が完了しました", [
        "このタブを閉じて、Terasuma の画面に戻ってください。",
        "Authorization is complete. Close this tab and return to Terasma.",
      ]);
    },
  };
}

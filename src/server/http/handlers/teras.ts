import { isReplyLanguage } from "../../../shared/language";
import { resolveModel } from "../../provider/routing";
import { createTurns } from "../../agent/turns";
import { ValidationError } from "../../errors";
import { readJsonBody } from "../body";
import { json, jsonError } from "../respond";
import { createSseResponse } from "../sse";
import { type ApiDeps, type ApiRequest, requireTera } from "./shared";

/**
 * Tera（会話の持ち主）と、その 1 本の履歴。
 */
export function terasHandlers(deps: ApiDeps) {
  const { store, settings } = deps;

  // 同じ Tera でターンが重なると、履歴の並びと引き受けの待ちが壊れる。
  // 「実行中かどうか」はターンの側が持つ（HTTP 層へ Set を渡さない）。
  const turns = createTurns(deps);

  return {
    /** 画面に並べる Tera の一覧。いまは既定の 1 体だけ。 */
    listTeras(): Response {
      return json({ teras: store.listTeras() });
    },

    listMessages(req: ApiRequest<{ id: string }>): Response {
      requireTera(store, req.params.id);
      return json({ messages: store.listMessages(req.params.id) });
    },

    /**
     * ユーザー発言を保存し、そのターンの応答を SSE で流す。
     * 会話は Tera ごとに 1 本なので、履歴はこの Tera に追記されていく。
     */
    async sendMessage(req: ApiRequest<{ id: string }>): Promise<Response> {
      const body = await readJsonBody(req);
      const raw = typeof body?.["content"] === "string" ? body["content"] : "";
      const content = raw.trim();
      if (content.length === 0) throw new ValidationError("content must be a non-empty string");

      const language = body?.["language"];
      if (!isReplyLanguage(language)) throw new ValidationError('language must be "ja" or "en"');

      requireTera(store, req.params.id);

      // モデルを呼べない状態なら、ターンを始めずに理由を返す。
      // 呼び出しの中で初めて失敗すると、画面には「モデルから応答を得られませんでした」としか出せない。
      const resolution = resolveModel(settings.read(), deps.catalog.snapshot());
      if (!resolution.ok) return jsonError(400, "model_not_configured", resolution.detail);

      const events = turns.begin(req.params.id, { content, language, signal: req.signal });
      if (events === null) {
        return jsonError(409, "turn_in_progress", "この Tera はほかで応答を生成しています");
      }
      return createSseResponse(events);
    },
  };
}

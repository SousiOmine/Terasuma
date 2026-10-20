import { resolveModel } from "../../provider/routing";
import { saveUploads } from "../../computer/uploads";
import { createTurns } from "../../agent/turns";
import { ValidationError } from "../../errors";
import { readTurnForm } from "../body";
import { json, jsonError } from "../respond";
import { createSseResponse } from "../sse";
import { type ApiDeps, type ApiRequest, requireTera } from "./shared";

/**
 * Tera（会話の持ち主）と、その 1 本の履歴。
 */
export function terasHandlers(deps: ApiDeps) {
  const { store, settings, container } = deps;

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
      // 無い Tera へ大きなファイルを送られたとき、本文を読む前に断る。
      requireTera(store, req.params.id);

      const form = await readTurnForm(req);
      if (form.content.length === 0 && form.files.length === 0) {
        throw new ValidationError("content or files must be provided");
      }

      // モデルを呼べない状態なら、ターンを始めずに理由を返す。
      // 呼び出しの中で初めて失敗すると、画面には「モデルから応答を得られませんでした」としか出せない。
      // ファイルを置く前に確かめて、無駄なファイルを残さない。
      const resolution = resolveModel(settings.read(), deps.catalog.snapshot());
      if (!resolution.ok) return jsonError(400, "model_not_configured", resolution.detail);

      const uploaded = await saveUploads(container, form.files, req.signal);
      const attachments = uploaded.length === 0 ? null : uploaded;

      const events = turns.begin(req.params.id, {
        content: form.content,
        attachments,
        language: form.language,
        signal: req.signal,
      });
      if (events === null) {
        return jsonError(409, "turn_in_progress", "この Tera はほかで応答を生成しています");
      }
      return createSseResponse(events);
    },
  };
}

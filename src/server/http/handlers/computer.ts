import { readJsonBody } from "../body";
import { jsonError, noContent } from "../respond";
import { type ApiDeps, type ApiRequest } from "./shared";

/**
 * コンピュータの操作のうち、画面を渡している間の受け渡し。
 * VNC の WebSocket 中継は http/server.ts が持つ（Bun の upgrade が要るため）。
 */
export function computerHandlers(deps: ApiDeps) {
  return {
    /**
     * 引き受け（画面を渡している間）の返事。
     * チャットに書いた文か、「操作を完了した」を、待っているツールの戻り値にする。
     */
    async answerHandover(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const teraId = typeof body?.["teraId"] === "string" ? body["teraId"] : "";
      if (teraId.length === 0) {
        return jsonError(400, "invalid_request", "teraId を指定してください");
      }

      const kind = body?.["kind"];
      if (kind === "text") {
        const raw = body?.["text"];
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text.length === 0) return jsonError(400, "invalid_request", "送る文が空です");

        if (!deps.handover.answer(teraId, { kind: "text", text })) {
          return jsonError(409, "handover_not_pending", "この Tera は操作を待っていません");
        }
        return noContent();
      }

      if (kind === "done") {
        if (!deps.handover.answer(teraId, { kind: "done" })) {
          return jsonError(409, "handover_not_pending", "この Tera は操作を待っていません");
        }
        return noContent();
      }

      return jsonError(400, "invalid_request", 'kind は "text" か "done" にしてください');
    },
  };
}

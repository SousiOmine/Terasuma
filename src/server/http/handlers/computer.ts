import { isEnvName } from "../../../shared/env";
import { describeError } from "../../../shared/errors";
import type { ComputerEnvView } from "../../../shared/types";
import { normalizeEnvValue } from "../../computer/env";
import type { SettingsStore } from "../../data/settings";
import { ValidationError } from "../../errors";
import { readJsonBody } from "../body";
import { json, jsonError, noContent } from "../respond";
import type { ApiDeps, ApiRequest } from "./shared";

/** 環境変数の一覧を、画面へ返す形にする。値は返さない。 */
function envView(settings: SettingsStore): ComputerEnvView {
  return { variables: Object.keys(settings.read().env).sort() };
}

/**
 * コンピュータに関する API。
 *
 * 画面を渡している間の受け渡し（引き受け）と、コンピュータのコマンドへ渡す環境変数
 * （一覧は名前だけ。値は返さない）、待っている環境変数の入力。
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

    /** コンピュータのコマンドへ渡す環境変数の名前。値は返さない。 */
    listEnv(): Response {
      return json(envView(deps.settings));
    },

    /** 環境変数を消す。次のコマンドから使えなくなる。 */
    deleteEnv(req: ApiRequest<{ name: string }>): Response {
      const { name } = req.params;
      if (!isEnvName(name)) throw new ValidationError("環境変数名の形式が違います");

      deps.settings.deleteEnv(name);
      return json(envView(deps.settings));
    },

    /**
     * 待っている環境変数の入力。
     * 値はこの経路でだけ受け取り、ツールの戻り値（モデルへ渡る文）には含めない。
     */
    async answerEnv(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const teraId = typeof body?.["teraId"] === "string" ? body["teraId"] : "";
      if (teraId.length === 0) {
        return jsonError(400, "invalid_request", "teraId を指定してください");
      }

      // 名前が違う返事は、遅れて届いた別の呼び出しのもの。受け付けない。
      const name = typeof body?.["name"] === "string" ? body["name"] : "";
      if (!isEnvName(name)) return jsonError(400, "invalid_request", "環境変数名を指定してください");

      const kind = body?.["kind"];
      if (kind === "cancel") {
        if (!deps.envRequests.answer(teraId, { kind: "cancel", name })) {
          return jsonError(409, "env_request_not_pending", "この Tera は環境変数の入力を待っていません");
        }
        return noContent();
      }

      if (kind !== "value") {
        return jsonError(400, "invalid_request", 'kind は "value" か "cancel" にしてください');
      }

      const raw = body?.["value"];
      if (typeof raw !== "string") return jsonError(400, "invalid_request", "value を指定してください");

      let value: string;
      try {
        value = normalizeEnvValue(raw);
      } catch (error) {
        // 送られた値そのものは、理由にも応答にも含めない。
        return jsonError(400, "invalid_request", describeError(error));
      }

      if (!deps.envRequests.answer(teraId, { kind: "value", name, value })) {
        return jsonError(409, "env_request_not_pending", "この Tera は環境変数の入力を待っていません");
      }
      return noContent();
    },
  };
}

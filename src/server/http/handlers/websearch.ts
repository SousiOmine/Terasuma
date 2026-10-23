/**
 * Web 検索プロバイダの設定。
 *
 * 設定を変える API はすべて、変えた後の全体を返す（画面は返ってきた値をそのまま置き直す）。
 * 接続確認は保存の前だけに使い、失敗しても HTTP は 200 で理由を返す。
 */

import { describeError } from "../../../shared/errors";
import type { WebSearchProviderForm } from "../../../shared/api/settings";
import { ValidationError, WebSearchProviderExists, WebSearchProviderNotFound } from "../../errors";
import { webSearchProviderSettingsFromForm } from "../../data/settings";
import type { WebSearchProviderSettings } from "../../data/settings";
import { isWebSearchProviderId } from "../../websearch/index";
import { readJsonBody, readWebSearchForm } from "../body";
import { json } from "../respond";
import { toWebSearchView } from "../views";
import type { ApiDeps, ApiRequest } from "./shared";
import { settingsWriter } from "./settings";

export function webSearchHandlers(deps: Pick<ApiDeps, "settings" | "webSearch">) {
  const { settings, webSearch } = deps;

  function currentView(): Response {
    return json(toWebSearchView(settings.read().webSearch));
  }

  const commit = settingsWriter(currentView);

  /** 入力を、保存できる設定にする。検証の規則は設定ファイル側に任せる。 */
  function settingsFrom(form: WebSearchProviderForm, id: string): WebSearchProviderSettings {
    try {
      return webSearchProviderSettingsFromForm(form, `webSearch.providers.${id}`);
    } catch (error) {
      throw new ValidationError(describeError(error));
    }
  }

  return {
    /** 設定画面を開いたときに読む、Web 検索設定の全体。 */
    readWebSearch(): Response {
      return currentView();
    },

    /** 検索プロバイダを追加する。既定が未設定なら、このプロバイダが既定になる。 */
    async addWebSearchProvider(req: ApiRequest): Promise<Response> {
      const form = await readWebSearchForm(req);
      if (settings.read().webSearch.providers[form.id] !== undefined) {
        throw new WebSearchProviderExists(form.id);
      }

      const provider = settingsFrom(form, form.id);
      return commit(() => settings.putWebSearchProvider(form.id, provider));
    },

    /** 検索プロバイダの設定を変える。apiKey が null なら保存済みのキーを使う。 */
    async updateWebSearchProvider(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      const existing = settings.read().webSearch.providers[id];
      if (existing === undefined) throw new WebSearchProviderNotFound(id);

      const form = await readWebSearchForm(req);
      if (form.id.length > 0 && form.id !== id) {
        throw new ValidationError(`id は URL の ${id} と同じにしてください`);
      }

      const provider = settingsFrom({ id, apiKey: form.apiKey ?? existing.apiKey }, id);
      return commit(() => settings.putWebSearchProvider(id, provider));
    },

    /** 検索プロバイダを消す。既定だった場合は既定も未設定に戻る。 */
    removeWebSearchProvider(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      if (settings.read().webSearch.providers[id] === undefined) {
        throw new WebSearchProviderNotFound(id);
      }
      return commit(() => void settings.deleteWebSearchProvider(id));
    },

    /** 既定の検索プロバイダを変える。id が null なら未設定に戻す。 */
    async setDefaultWebSearchProvider(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const raw = body?.["id"];
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        throw new ValidationError("id must be a string or null");
      }

      const id = typeof raw === "string" ? raw.trim() : null;
      if (id !== null && settings.read().webSearch.providers[id] === undefined) {
        throw new WebSearchProviderNotFound(id);
      }
      return commit(() => settings.setDefaultWebSearchProvider(id));
    },

    /** 保存する前に、入力された API キーで検索できるか確かめる。設定には何も書かない。 */
    async testWebSearchProvider(req: ApiRequest): Promise<Response> {
      const form = await readWebSearchForm(req);
      if (!isWebSearchProviderId(form.id)) {
        throw new ValidationError(`未知の検索プロバイダです: ${form.id}`);
      }

      return json(await webSearch.test({ id: form.id, apiKey: form.apiKey }, req.signal));
    },
  };
}

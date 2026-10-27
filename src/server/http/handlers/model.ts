import { describeError } from "../../../shared/errors";
import { isModelId, modelParts, modelProvider } from "../../../shared/model";
import { findEndpointPreset } from "../../../shared/providers";
import type { CatalogProviderView, ProviderCheckResult, ReasoningView } from "../../../shared/api/settings";
import { selectableEfforts } from "../../provider/reasoning";
import type { ProviderSettings } from "../../data/settings";
import { AppError, CatalogUnavailableError, ValidationError } from "../../errors";
import { catalogModel, catalogModels, catalogProvider, type CatalogSnapshot } from "../../provider/catalog";
import { type ConnectionTarget, connectionTarget } from "../../provider/connection";
import { providerSpecForId } from "../../provider/kinds";
import { parseProviderSettings, readCredentials, readDefaultModel, readJsonBody, readProviderId } from "../body";
import { json } from "../respond";
import { toSettingsView } from "../views";
import { type ApiDeps, type ApiRequest, requireProvider } from "./shared";
import { settingsWriter } from "./settings";

/**
 * モデルとプロバイダの設定。
 *
 * 設定を変える API はすべて、変えた後の全体を返す（画面は返ってきた値をそのまま置き直す）。
 * カタログと接続確認は、設定画面を開いたときと保存の前だけ使う。
 */
export function modelHandlers(deps: Pick<ApiDeps, "settings" | "catalog" | "checkConnection" | "listModels">) {
  const { settings } = deps;

  /** モデル設定の現在の状態。 */
  function currentView(): Response {
    return json(toSettingsView(settings.read()));
  }

  const commit = settingsWriter(currentView);

  /**
   * カタログを使える状態にする。
   * 設定画面を開いたときだけ取りに行き、チャットの呼び出しでは通信を待たない。
   */
  async function loadCatalog(options: { fresh?: boolean } = {}): Promise<CatalogSnapshot> {
    try {
      return await deps.catalog.load(options);
    } catch (error) {
      throw new CatalogUnavailableError(describeError(error), error);
    }
  }

  /** 既定のモデルの思考強度。選べる値も一緒に返す。 */
  function reasoningView(snapshot: CatalogSnapshot): ReasoningView {
    const model = settings.read().model;
    if (model === null) return { model: null, effort: null, values: [] };

    const { provider } = modelParts(model);
    const spec = providerSpecForId(provider, catalogProvider(snapshot, provider)?.npm ?? null);

    return {
      model,
      effort: settings.read().modelOptions[model]?.reasoningEffort ?? null,
      values: selectableEfforts(spec, catalogModel(snapshot, model)),
    };
  }

  /** 接続確認の宛先。カタログを読んでいなければ、カタログのプロバイダでも宛先は分からない。 */
  function targetOf(id: string, provider: ProviderSettings): ConnectionTarget | null {
    const baseUrl = provider.baseUrl ?? findEndpointPreset(id)?.defaultBaseUrl ?? null;
    const api = deps.catalog.snapshot()?.providers.find((candidate) => candidate.id === id)?.api ?? null;
    return connectionTarget({ id, baseUrl, api });
  }

  /** 保存の前後の接続確認。失敗はそのまま投げる（応答への変換は respond.ts が行う）。 */
  async function verifyProvider(
    id: string,
    provider: ProviderSettings,
    signal: AbortSignal,
  ): Promise<ProviderCheckResult> {
    return deps.checkConnection({
      target: targetOf(id, provider),
      apiKey: provider.apiKey ?? null,
      signal,
    });
  }

  return {
    /** 設定画面を開いたときに読む、モデル設定の全体。 */
    readModelSettings(): Response {
      return currentView();
    },

    /** 既定のモデルを変える。設定済みのプロバイダのモデルしか受け付けない。 */
    async setDefaultModel(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const model = body?.["model"];
      if (typeof model !== "string" || !isModelId(model)) {
        throw new ValidationError('model must be a "provider/model" string');
      }

      const providerId = modelProvider(model);
      if (settings.read().providers[providerId] === undefined) {
        throw new ValidationError(`プロバイダ ${providerId} が設定されていません`);
      }

      return commit(() => settings.setModel(model));
    },

    /**
     * 既定のモデルの思考強度と、選べる値を返す。
     * 設定画面の「思考強度」は、いま選ばれているモデルの分だけを出す。
     */
    async readReasoning(): Promise<Response> {
      // モデルが未設定なら見る値が無い。カタログも取りに行かない。
      if (settings.read().model === null) {
        return json({ model: null, effort: null, values: [] } satisfies ReasoningView);
      }

      return json(reasoningView(await loadCatalog({ fresh: true })));
    },

    /**
     * 既定のモデルの思考強度を変える。
     * モデルごとに保存するので、別のモデルへ切り替えて戻ると前の値が復元される。
     */
    async setReasoning(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const raw = body?.["reasoningEffort"];
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        throw new ValidationError("reasoningEffort must be a string or null");
      }

      const effort = typeof raw === "string" ? raw.trim() : null;
      if (effort !== null && effort.length === 0) {
        throw new ValidationError("reasoningEffort must be a non-empty string or null");
      }

      const model = settings.read().model;
      if (model === null) throw new ValidationError("既定のモデルが設定されていません");

      // 値はモデルが受け付けるものだけを通す。渡せない値が設定に入ると、次の送信が必ず失敗する。
      const snapshot = await loadCatalog({ fresh: true });

      if (effort !== null) {
        const { provider } = modelParts(model);
        const spec = providerSpecForId(provider, catalogProvider(snapshot, provider)?.npm ?? null);
        const values = selectableEfforts(spec, catalogModel(snapshot, model));

        if (!values.includes(effort)) {
          throw new ValidationError(
            values.length === 0
              ? `${model} は思考強度を指定できません`
              : `${model} の思考強度は ${values.join(", ")} のいずれかにしてください`,
          );
        }
      }

      commit(() => settings.setReasoningEffort(model, effort));
      return json(reasoningView(snapshot));
    },

    /** 設定画面に並べるプロバイダの一覧（models.dev のカタログ）。 */
    async listCatalogProviders(): Promise<Response> {
      const snapshot = await loadCatalog({ fresh: true });

      const providers: CatalogProviderView[] = snapshot.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: catalogModels(snapshot, provider.id)?.length ?? 0,
      }));
      return json({ providers });
    },

    /** カタログのプロバイダで使えるモデルの一覧。追加ウィザードが使う。 */
    async listCatalogModels(req: ApiRequest<{ id: string }>): Promise<Response> {
      const snapshot = await loadCatalog({ fresh: true });

      const models = catalogModels(snapshot, req.params.id);
      if (models === undefined) {
        throw new AppError("provider_not_found", `プロバイダ ${req.params.id} がカタログにありません`);
      }
      return json({ models: models.map((model) => model.id) });
    },

    /**
     * 保存せずに接続だけを確かめる。
     * モデルの一覧はカタログから取るので、ここで見るのは資格が通るかどうかだけ。
     * 確認する手段が無いプロバイダは verified: false で返し、保存は妨げない。
     */
    async checkProvider(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const id = readProviderId(body);

      return json(await verifyProvider(id, parseProviderSettings(id, body), req.signal));
    },

    /**
     * プロバイダを追加する。保存の前に接続を確かめるが、
     * 確認する手段が無いプロバイダはそのまま保存できる。
     */
    async addProvider(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const id = readProviderId(body);

      if (settings.read().providers[id] !== undefined) {
        throw new AppError("provider_exists", `プロバイダ ${id} はすでに設定されています`);
      }

      const defaultModel = readDefaultModel(body);
      if (defaultModel !== null && modelProvider(defaultModel) !== id) {
        throw new ValidationError(`defaultModel は追加するプロバイダ ${id} のモデルにしてください`);
      }

      const provider = parseProviderSettings(id, body);
      await verifyProvider(id, provider, req.signal);

      return commit(() => settings.putProvider(id, provider, defaultModel ?? undefined));
    },

    /**
     * プロバイダの設定を変える。apiKey を空で送った場合は、保存済みのキーをそのまま使う。
     * API キーは画面へ返さないので、変更しない限り入力し直せないため。
     */
    async updateProvider(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      const existing = requireProvider(settings, id);

      const body = await readJsonBody(req);
      const credentials = readCredentials(body);

      // API キーは画面へ返さないので、空で送られたときは保存済みのものを使う。
      // 空文字も「未入力」として扱う（providerSettingsFromForm は空文字を落とすため、
      // そのまま渡すと保存済みのキーが黙って消える）。
      const apiKey = credentials.apiKey?.trim();
      const merged = {
        ...credentials,
        apiKey: apiKey === undefined || apiKey.length === 0 ? (existing.apiKey ?? null) : apiKey,
      };

      const provider = parseProviderSettings(id, merged);
      await verifyProvider(id, provider, req.signal);

      return commit(() => settings.putProvider(id, provider));
    },

    removeProvider(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      // 設定に無いものは消せない。画面が見ていた状態と揃うよう、ここで 404 にする。
      requireProvider(settings, id);
      // 直前に手で消されていた場合は、書くものが無いだけで結果は同じ。
      return commit(() => void settings.deleteProvider(id));
    },

    /**
     * 設定済みのプロバイダで使えるモデルの一覧。既定のモデルを選び直すときに使う。
     * カタログのプロバイダはカタログから、独自エンドポイントは /models から取る。
     */
    async listProviderModels(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      const provider = requireProvider(settings, id);

      if (provider.baseUrl === undefined) {
        const models = catalogModels(await loadCatalog(), id);
        if (models === undefined) {
          throw new AppError("provider_not_found", `プロバイダ ${id} がカタログにありません`);
        }
        return json({ models: models.map((model) => model.id) });
      }

      const models = await deps.listModels({
        target: connectionTarget({ id, baseUrl: provider.baseUrl, api: null }),
        apiKey: provider.apiKey ?? null,
        signal: req.signal,
      });
      return json({ models });
    },
  };
}

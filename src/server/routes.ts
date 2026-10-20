import type { ProviderSettings } from "../config";
import { isReplyLanguage } from "../shared/language";
import { isModelId, modelParts, modelProvider } from "../shared/model";
import { findEndpointPreset } from "../shared/providers";
import type {
  CatalogProviderView,
  ContainerStatusView,
  McpAuthorizationView,
  ProviderCheckResult,
  ProviderCredentials,
  ReasoningView,
} from "../shared/types";
import { resolveModel, type AgentEngine } from "./engine";
import type { Compaction } from "./compaction";
import { ContainerError, type ContainerErrorCode, type ContainerManager } from "./container";
import type { Handover } from "./handover";
import { describeError } from "../shared/errors";
import { jsonError } from "./errors";
import {
  parseProviderSettings,
  readCredentials,
  readDefaultModel,
  readJsonBody,
  readMcpForm,
  readProviderId,
} from "./body";
import { authorizationPage, toMcpView, toSettingsView } from "./views";
import { runTurn, sseResponse } from "./turn";
import { McpServerNotFound, type McpManager } from "./mcp";
import { catalogProvider, type Catalog, type CatalogSnapshot } from "./models-dev";
import {
  ProviderRequestError,
  connectionTarget,
  type ConnectionChecker,
  type ConnectionTarget,
  type ProviderModelLister,
} from "./provider-models";
import { providerSpecForId } from "./provider-registry";
import { selectableEfforts } from "./reasoning";
import type { SettingsStore } from "./settings";
import type { Store } from "./store";

/**
 * ハンドラが必要とする最小限のリクエスト形状。
 * Bun 固有の型に依存させないことで、ルーティングと HTTP 処理を分けて読めるようにしている。
 * パラメータを持たないルートでは、型引数を省ける。
 */
export type ApiRequest<Params extends Record<string, string> = Record<string, never>> = {
  params: Params;
  signal: AbortSignal;
  json(): Promise<unknown>;
};

/**
 * 画面の中継のルート。server.ts のルート定義（"/api/computer/screen/*"）と同じパスにする。
 * 中継先へ渡すパスは、この接頭辞を落として作る。
 */
export const SCREEN_RELAY_PREFIX = "/api/computer/screen/";

/** 画面の中継のリクエスト。 */
export type ScreenRelayRequest = {
  url: string;
  signal: AbortSignal;
};

export type ApiDeps = {
  store: Store;
  engine: AgentEngine;
  /** モデルとプロバイダの設定。変更は config.json に書き戻される。 */
  settings: SettingsStore;
  /** MCP サーバーとの接続。設定画面からの操作もここを通す。 */
  mcp: McpManager;
  /** podman で動かすコンテナ。設定画面からの起動とリセットもここを通す。 */
  container: ContainerManager;
  /** ユーザーへ画面を渡す待ち。チャットからの返事をここへ届ける。 */
  handover: Handover;
  /** 過去の対話の圧縮。ターンの前に走っている分を待ち、ターンの後に次を決める。 */
  compaction: Compaction;
  /** models.dev のカタログ。プロバイダとモデルの一覧はここから取る。 */
  catalog: Catalog;
  /** プロバイダへ接続できるかを確かめる。 */
  checkConnection: ConnectionChecker;
  /** 独自エンドポイントのモデル一覧を取る。 */
  listModels: ProviderModelLister;
};

export function createApiHandlers(deps: ApiDeps) {
  const { store, settings } = deps;

  /**
   * いま応答を生成している Tera。
   * 同じ Tera でターンが重なると、履歴の並びと引き受けの待ちが壊れる。
   * 画面は 1 つのターンしか始めないが、別のタブから同じ Tera を開けるため、ここでも断る。
   */
  const turnRunning = new Set<string>();

  /** モデル設定の現在の状態。設定を変える API はすべてこれを返す。 */
  function currentView(): Response {
    return Response.json(toSettingsView(settings.read()));
  }

  /**
   * 設定を書き換えて、書き換えた後の全体を返す。
   * 書けなかった理由（置き場所の権限が無い、起動中に手で壊されたなど）は、
   * そのまま返して画面に出せるようにする。
   */
  function commit(change: () => void): Response {
    try {
      change();
    } catch (error) {
      return jsonError(500, "settings_write_failed", describeError(error));
    }
    return currentView();
  }

  /** MCP の設定を書き換えて、書き換えた後の全体を返す。 */
  function commitMcp(change: () => void): Response {
    try {
      change();
    } catch (error) {
      return jsonError(500, "settings_write_failed", describeError(error));
    }
    return Response.json(toMcpView(settings.readMcp().servers, deps.mcp));
  }

  /**
   * カタログを使える状態にする。
   * 設定画面を開いたときだけ取りに行き、チャットの呼び出しでは通信を待たない。
   */
  async function loadCatalog(): Promise<CatalogSnapshot | Response> {
    try {
      return await deps.catalog.load({ fresh: true });
    } catch (error) {
      return jsonError(502, "catalog_unavailable", describeError(error));
    }
  }

  /** 既定のモデルの思考強度。選べる値も一緒に返す。 */
  function reasoningView(snapshot: CatalogSnapshot): Response {
    const model = settings.read().model;
    if (model === null) {
      return Response.json({ model: null, effort: null, values: [] } satisfies ReasoningView);
    }

    const { provider, model: modelName } = modelParts(model);
    const entry = snapshot.models.get(provider)?.find((candidate) => candidate.id === modelName) ?? null;
    const spec = providerSpecForId(provider, catalogProvider(snapshot, provider)?.npm ?? null);

    return Response.json({
      model,
      effort: settings.read().modelOptions[model]?.reasoningEffort ?? null,
      values: selectableEfforts(spec, entry),
    } satisfies ReasoningView);
  }

  return {
    /** 画面に並べる Tera の一覧。いまは既定の 1 体だけ。 */
    listTeras(): Response {
      return Response.json({ teras: store.listTeras() });
    },

    listMessages(req: ApiRequest<{ id: string }>): Response {
      if (store.getTera(req.params.id) === null) {
        return jsonError(404, "tera_not_found");
      }
      return Response.json({ messages: store.listMessages(req.params.id) });
    },

    /**
     * ユーザー発言を保存し、そのターンの応答を SSE で流す。
     * 会話は Tera ごとに 1 本なので、履歴はこの Tera に追記されていく。
     */
    async sendMessage(req: ApiRequest<{ id: string }>): Promise<Response> {
      const body = await readJsonBody(req);
      const raw = typeof body?.["content"] === "string" ? body["content"] : "";
      const content = raw.trim();
      if (content.length === 0) {
        return jsonError(400, "invalid_request", "content must be a non-empty string");
      }

      const language = body?.["language"];
      if (!isReplyLanguage(language)) {
        return jsonError(400, "invalid_request", 'language must be "ja" or "en"');
      }

      if (store.getTera(req.params.id) === null) {
        return jsonError(404, "tera_not_found");
      }

      // モデルを呼べない状態なら、ターンを始めずに理由を返す。
      // 呼び出しの中で初めて失敗すると、画面には「モデルから応答を得られませんでした」としか出せない。
      const resolution = resolveModel(settings.read(), deps.catalog.snapshot());
      if (!resolution.ok) {
        return jsonError(400, "model_not_configured", resolution.detail);
      }

      if (turnRunning.has(req.params.id)) {
        return jsonError(409, "turn_in_progress", "この Tera はほかで応答を生成しています");
      }

      turnRunning.add(req.params.id);
      return sseResponse(runTurn(deps, req.params.id, content, language, req.signal, turnRunning));
    },

    /** 設定画面を開いたときに読む、モデル設定の全体。 */
    readModelSettings(): Response {
      return currentView();
    },

    /** 既定のモデルを変える。設定済みのプロバイダのモデルしか受け付けない。 */
    async setDefaultModel(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const model = body?.["model"];
      if (typeof model !== "string" || !isModelId(model)) {
        return jsonError(400, "invalid_request", 'model must be a "provider/model" string');
      }

      const providerId = modelProvider(model);
      if (settings.read().providers[providerId] === undefined) {
        return jsonError(400, "invalid_request", `プロバイダ ${providerId} が設定されていません`);
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
        return Response.json({ model: null, effort: null, values: [] } satisfies ReasoningView);
      }

      const snapshot = await loadCatalog();
      if (snapshot instanceof Response) return snapshot;
      return reasoningView(snapshot);
    },

    /**
     * 既定のモデルの思考強度を変える。
     * モデルごとに保存するので、別のモデルへ切り替えて戻ると前の値が復元される。
     */
    async setReasoning(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const raw = body?.["reasoningEffort"];
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        return jsonError(400, "invalid_request", "reasoningEffort must be a string or null");
      }

      const effort = typeof raw === "string" ? raw.trim() : null;
      if (effort !== null && effort.length === 0) {
        return jsonError(400, "invalid_request", "reasoningEffort must be a non-empty string or null");
      }

      const model = settings.read().model;
      if (model === null) {
        return jsonError(400, "invalid_request", "既定のモデルが設定されていません");
      }

      // 値はモデルが受け付けるものだけを通す。渡せない値が設定に入ると、次の送信が必ず失敗する。
      const snapshot = await loadCatalog();
      if (snapshot instanceof Response) return snapshot;

      if (effort !== null) {
        const { provider, model: modelName } = modelParts(model);
        const entry = snapshot.models.get(provider)?.find((candidate) => candidate.id === modelName) ?? null;
        const spec = providerSpecForId(provider, catalogProvider(snapshot, provider)?.npm ?? null);
        const values = selectableEfforts(spec, entry);

        if (!values.includes(effort)) {
          return jsonError(
            400,
            "invalid_request",
            values.length === 0
              ? `${model} は思考強度を指定できません`
              : `${model} の思考強度は ${values.join(", ")} のいずれかにしてください`,
          );
        }
      }

      const response = commit(() => settings.setReasoningEffort(model, effort));
      return response.ok ? reasoningView(snapshot) : response;
    },

    /** 設定画面に並べるプロバイダの一覧（models.dev のカタログ）。 */
    async listCatalogProviders(): Promise<Response> {
      const snapshot = await loadCatalog();
      if (snapshot instanceof Response) return snapshot;

      const providers: CatalogProviderView[] = snapshot.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: snapshot.models.get(provider.id)?.length ?? 0,
      }));
      return Response.json({ providers });
    },

    /** カタログのプロバイダで使えるモデルの一覧。追加ウィザードが使う。 */
    async listCatalogModels(req: ApiRequest<{ id: string }>): Promise<Response> {
      const snapshot = await loadCatalog();
      if (snapshot instanceof Response) return snapshot;

      const models = snapshot.models.get(req.params.id);
      if (models === undefined) {
        return jsonError(404, "provider_not_found", `プロバイダ ${req.params.id} がカタログにありません`);
      }
      return Response.json({ models: models.map((model) => model.id) });
    },

    /**
     * 保存せずに接続だけを確かめる。
     * モデルの一覧はカタログから取るので、ここで見るのは資格が通るかどうかだけ。
     * 確認する手段が無いプロバイダは verified: false で返し、保存は妨げない。
     */
    async checkProvider(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const id = readProviderId(body);
      if (id === null) return jsonError(400, "invalid_request", "id must be a provider id");

      const provider = parseProviderSettings(id, body);
      if (provider instanceof Response) return provider;

      const result = await verifyProvider(id, provider, req.signal);
      return result instanceof Response ? result : Response.json(result);
    },

    /**
     * プロバイダを追加する。保存の前に接続を確かめるが、
     * 確認する手段が無いプロバイダはそのまま保存できる。
     */
    async addProvider(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const id = readProviderId(body);
      if (id === null) return jsonError(400, "invalid_request", "id must be a provider id");

      if (settings.read().providers[id] !== undefined) {
        return jsonError(409, "provider_exists", `プロバイダ ${id} はすでに設定されています`);
      }

      const defaultModel = readDefaultModel(body);
      if (defaultModel instanceof Response) return defaultModel;
      if (defaultModel !== null && modelProvider(defaultModel) !== id) {
        return jsonError(400, "invalid_request", `defaultModel は追加するプロバイダ ${id} のモデルにしてください`);
      }

      const provider = parseProviderSettings(id, body);
      if (provider instanceof Response) return provider;

      const failure = await verifyProvider(id, provider, req.signal);
      if (failure instanceof Response) return failure;

      return commit(() => settings.putProvider(id, provider, defaultModel ?? undefined));
    },

    /**
     * プロバイダの設定を変える。apiKey を空で送った場合は、保存済みのキーをそのまま使う。
     * API キーは画面へ返さないので、変更しない限り入力し直せないため。
     */
    async updateProvider(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      const existing = settings.read().providers[id];
      if (existing === undefined) {
        return jsonError(404, "provider_not_found", `プロバイダ ${id} は設定されていません`);
      }

      const body = await readJsonBody(req);
      const credentials = readCredentials(body);
      if (credentials === null) {
        return jsonError(400, "invalid_request", "apiKey, baseUrl, label must be strings or null");
      }

      // API キーは画面へ返さないので、空で送られたときは保存済みのものを使う。
      // 空文字も「未入力」として扱う（providerSettingsFromForm は空文字を落とすため、
      // そのまま渡すと保存済みのキーが黙って消える）。
      const apiKey = credentials.apiKey?.trim();
      const merged: ProviderCredentials = {
        ...credentials,
        apiKey: apiKey === undefined || apiKey.length === 0 ? (existing.apiKey ?? null) : apiKey,
      };

      const provider = parseProviderSettings(id, merged);
      if (provider instanceof Response) return provider;

      const failure = await verifyProvider(id, provider, req.signal);
      if (failure instanceof Response) return failure;

      return commit(() => settings.putProvider(id, provider));
    },

    removeProvider(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      // 設定に無いものは消せない。画面が見ていた状態と揃うよう、ここで 404 にする。
      if (settings.read().providers[id] === undefined) {
        return jsonError(404, "provider_not_found", `プロバイダ ${id} は設定されていません`);
      }
      // 直前に手で消されていた場合は、書くものが無いだけで結果は同じ。
      return commit(() => void settings.deleteProvider(id));
    },

    /**
     * 設定済みのプロバイダで使えるモデルの一覧。既定のモデルを選び直すときに使う。
     * カタログのプロバイダはカタログから、独自エンドポイントは /models から取る。
     */
    async listProviderModels(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      const provider = settings.read().providers[id];
      if (provider === undefined) {
        return jsonError(404, "provider_not_found", `プロバイダ ${id} は設定されていません`);
      }

      if (provider.baseUrl === undefined) {
        let snapshot: CatalogSnapshot;
        try {
          snapshot = await deps.catalog.load();
        } catch (error) {
          return jsonError(502, "catalog_unavailable", describeError(error));
        }

        const models = snapshot.models.get(id);
        if (models === undefined) {
          return jsonError(404, "provider_not_found", `プロバイダ ${id} がカタログにありません`);
        }
        return Response.json({ models: models.map((model) => model.id) });
      }

      try {
        const models = await deps.listModels({
          target: connectionTarget({ id, baseUrl: provider.baseUrl, api: null }),
          apiKey: provider.apiKey ?? null,
          signal: req.signal,
        });
        return Response.json({ models });
      } catch (error) {
        return providerFailureResponse(error);
      }
    },

    /** MCP サーバーの一覧（設定と、いま分かっている接続状態）。 */
    listMcpServers(): Response {
      return Response.json(toMcpView(settings.readMcp().servers, deps.mcp));
    },

    /**
     * MCP サーバーを追加する。繋がるかどうかは画面が確かめてからここへ来る
     * （同じ接続を 2 度試さないよう、ここでは確かめ直さない）。
     */
    async addMcpServer(req: ApiRequest): Promise<Response> {
      const parsed = await readMcpForm(req);
      if (parsed instanceof Response) return parsed;

      if (settings.readMcp().servers[parsed.id] !== undefined) {
        return jsonError(409, "mcp_server_exists", `MCP サーバー ${parsed.id} はすでに追加されています`);
      }

      return commitMcp(() => settings.putMcpServer(parsed.id, parsed.server));
    },

    /**
     * 保存する前に、入力された設定で繋がるか確かめる。設定には何も書かない。
     * サーバーが認可を求めた場合は、ブラウザで開く URL を返して認可を待つ。
     */
    async testMcpServer(req: ApiRequest): Promise<Response> {
      const parsed = await readMcpForm(req);
      if (parsed instanceof Response) return parsed;

      try {
        return Response.json(await deps.mcp.test(parsed.id, parsed.server));
      } catch (error) {
        return mcpFailureResponse(error);
      }
    },

    /** MCP サーバーの設定を変える。接続は次に確かめたときから新しい設定になる。 */
    async updateMcpServer(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      if (settings.readMcp().servers[id] === undefined) {
        return jsonError(404, "mcp_server_not_found", `MCP サーバー ${id} は設定されていません`);
      }

      const parsed = await readMcpForm(req);
      if (parsed instanceof Response) return parsed;

      if (parsed.id !== id) {
        return jsonError(400, "invalid_request", `id は URL の ${id} と同じにしてください`);
      }

      return commitMcp(() => settings.putMcpServer(id, parsed.server));
    },

    removeMcpServer(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      if (settings.readMcp().servers[id] === undefined) {
        return jsonError(404, "mcp_server_not_found", `MCP サーバー ${id} は設定されていません`);
      }

      deps.mcp.cancelAuthorization(id);
      return commitMcp(() => void settings.deleteMcpServer(id));
    },

    /** 接続を確かめ、公開されているツールを返す。 */
    async checkMcpServer(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      if (settings.readMcp().servers[id] === undefined) {
        return jsonError(404, "mcp_server_not_found", `MCP サーバー ${id} は設定されていません`);
      }

      try {
        return Response.json(await deps.mcp.check(id));
      } catch (error) {
        return mcpFailureResponse(error);
      }
    },

    /** OAuth の認可を始める。ブラウザで開く URL を返す。 */
    async authorizeMcpServer(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      if (settings.readMcp().servers[id] === undefined) {
        return jsonError(404, "mcp_server_not_found", `MCP サーバー ${id} は設定されていません`);
      }

      try {
        const result = await deps.mcp.authorize(id);
        return Response.json({ url: result.url } satisfies McpAuthorizationView);
      } catch (error) {
        if (error instanceof McpServerNotFound) return mcpFailureResponse(error);
        return jsonError(502, "mcp_authorization_failed", describeError(error));
      }
    },

    /** 待っている認可を取り消す。 */
    cancelMcpAuthorization(req: ApiRequest<{ id: string }>): Response {
      const id = req.params.id;
      if (settings.readMcp().servers[id] === undefined) {
        return jsonError(404, "mcp_server_not_found", `MCP サーバー ${id} は設定されていません`);
      }

      deps.mcp.cancelAuthorization(id);
      return Response.json(toMcpView(settings.readMcp().servers, deps.mcp));
    },

    /**
     * OAuth のリダイレクト先。ブラウザが直接開くため、JSON ではなく読める 1 枚のページを返す。
     * 成否はサーバーのログではなくここに出し、設定画面は接続を確かめ直して状態を拾う。
     */
    async mcpOAuthCallback(request: { url: string }): Promise<Response> {
      const url = new URL(request.url);
      const state = url.searchParams.get("state");
      if (state === null)
        return authorizationPage(400, "認可を確認できませんでした", [
          "URL に state がありません。",
          "Invalid callback: missing state.",
        ]);

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
        return new Response(null, { status: 204 });
      }

      if (kind === "done") {
        if (!deps.handover.answer(teraId, { kind: "done" })) {
          return jsonError(409, "handover_not_pending", "この Tera は操作を待っていません");
        }
        return new Response(null, { status: 204 });
      }

      return jsonError(400, "invalid_request", 'kind は "text" か "done" にしてください');
    },

    /** コンテナのいまの状態。設定画面とチャット画面がこれを見て案内を出す。 */
    async readContainer(): Promise<Response> {
      return Response.json(await deps.container.status());
    },

    /** コンテナを起動する。イメージが無ければ作り、コンテナが無ければ作るところまで行う。 */
    async startContainer(): Promise<Response> {
      return containerResponse(() => deps.container.start());
    },

    /** コンテナを作り直す。wipeHome を選んだときだけ、マウントしたフォルダの中身も消す。 */
    async resetContainer(req: ApiRequest): Promise<Response> {
      const body = await readJsonBody(req);
      return containerResponse(() => deps.container.reset({ wipeHome: body?.["wipeHome"] === true }));
    },

    /**
     * 画面の中継。コンテナの noVNC（websockify が配る HTML と JS）を Terasuma の待ち受けから返す。
     *
     * ブラウザへ見せる待ち受けを Terasuma の 1 つに保つため、コンテナのポートは直接見せない。
     * LAN へ公開したときのトークン認証も、この 1 か所に掛けられる。
     */
    async relayScreen(req: ScreenRelayRequest): Promise<Response> {
      const status = await deps.container.status();
      if (status.state !== "running" || status.vncPort === null) {
        return jsonError(409, "container_not_running", "コンピュータが動いていないため、画面を表示できません");
      }

      const incoming = new URL(req.url);
      // 中継の接頭辞を落として、コンテナのルートからのパスにする。問い合わせはそのまま渡す。
      const path = incoming.pathname.slice(SCREEN_RELAY_PREFIX.length);

      let upstream: Response;
      try {
        upstream = await fetch(`http://127.0.0.1:${status.vncPort}/${path}${incoming.search}`, {
          signal: req.signal,
        });
      } catch (error) {
        return jsonError(502, "container_not_running", `画面を取れませんでした: ${describeError(error)}`);
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
          // noVNC の JS は頻繁には変わらないが、古いものが残ると原因が分かりにくい。
          "Cache-Control": "no-store",
        },
      });
    },
  };

  /** 保存の前後に使う接続確認。失敗した場合はそのまま返せるレスポンスを返す。 */
  async function verifyProvider(
    id: string,
    provider: ProviderSettings,
    signal: AbortSignal,
  ): Promise<ProviderCheckResult | Response> {
    try {
      return await deps.checkConnection({
        target: targetOf(id, provider),
        apiKey: provider.apiKey ?? null,
        signal,
      });
    } catch (error) {
      return providerFailureResponse(error);
    }
  }

  /** 接続確認の宛先。カタログを読んでいなければ、カタログのプロバイダでも宛先は分からない。 */
  function targetOf(id: string, provider: ProviderSettings): ConnectionTarget | null {
    const baseUrl = provider.baseUrl ?? findEndpointPreset(id)?.defaultBaseUrl ?? null;
    const api = deps.catalog.snapshot()?.providers.find((candidate) => candidate.id === id)?.api ?? null;
    return connectionTarget({ id, baseUrl, api });
  }
}
function providerFailureResponse(error: unknown): Response {
  if (error instanceof ProviderRequestError) {
    // 認証の失敗は入力の問題なので 400、それ以外は接続先の問題として 502 にする。
    const status = error.code === "provider_auth_failed" ? 400 : 502;
    return jsonError(status, error.code, error.message);
  }
  return jsonError(500, "internal_error", describeError(error));
}

/** MCP の manager からの失敗を、そのまま返せるレスポンスにする。 */
function mcpFailureResponse(error: unknown): Response {
  if (error instanceof McpServerNotFound) return jsonError(404, "mcp_server_not_found", error.message);
  return jsonError(500, "internal_error", describeError(error));
}

/** コンテナの操作の失敗を、そのまま返せるレスポンスにする。 */
async function containerResponse(operation: () => Promise<ContainerStatusView>): Promise<Response> {
  try {
    return Response.json(await operation());
  } catch (error) {
    if (error instanceof ContainerError) {
      return jsonError(containerStatus(error.code), error.code, error.message);
    }
    return jsonError(500, "internal_error", describeError(error));
  }
}

/** コンテナの失敗を、画面が扱いやすい HTTP の状態にする。 */
function containerStatus(code: ContainerErrorCode): number {
  // 操作の前提（動いていること）が満たされていない。
  if (code === "container_not_running") return 409;
  // イメージの作成や起動の失敗は、接続先（podman）側の問題として扱う。
  return 502;
}

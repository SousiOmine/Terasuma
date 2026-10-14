import {
  isMcpServerId,
  isProviderId,
  mcpServerSettingsFromForm,
  normalizeProvider,
  providerSettingsFromForm,
  type McpServerSettings,
  type McpServersSettings,
  type ModelSettings,
  type ProviderSettings,
} from "../config";
import { isModelId, modelProvider, type ModelId } from "../shared/model";
import { findEndpointPreset } from "../shared/providers";
import { encodeChatEvent } from "../shared/sse";
import type {
  ChatEvent,
  ChatMessage,
  CatalogProviderView,
  McpAuthorizationView,
  McpServerForm,
  McpServersView,
  MessagePart,
  ModelSettingsView,
  ProviderCredentials,
  ProviderView,
  ReasoningView,
  TokenUsage,
} from "../shared/types";
import { resolveModel, type AgentEngine } from "./engine";
import { describeError, jsonError } from "./errors";
import { McpServerNotFound, type McpManager } from "./mcp";
import type { Catalog, CatalogSnapshot } from "./models-dev";
import {
  ProviderRequestError,
  connectionTarget,
  type ConnectionChecker,
  type ConnectionResult,
  type ConnectionTarget,
  type ProviderModelLister,
} from "./provider-models";
import { selectableEfforts } from "./reasoning";
import type { SettingsStore } from "./settings";
import type { Store } from "./store";

/**
 * ハンドラが必要とする最小限のリクエスト形状。
 * Bun 固有の型に依存させないことで、ルーティングと HTTP 処理を分けて読めるようにしている。
 */
export type ApiRequest<Params extends Record<string, string>> = {
  params: Params;
  signal: AbortSignal;
  json(): Promise<unknown>;
};

/** パラメータを持たないルートのリクエスト。 */
export type PlainRequest = {
  signal: AbortSignal;
  json(): Promise<unknown>;
};

export type ApiDeps = {
  store: Store;
  engine: AgentEngine;
  /** モデルとプロバイダの設定。変更は config.json に書き戻される。 */
  settings: SettingsStore;
  /** MCP サーバーとの接続。設定画面からの操作もここを通す。 */
  mcp: McpManager;
  /** models.dev のカタログ。プロバイダとモデルの一覧はここから取る。 */
  catalog: Catalog;
  /** プロバイダへ接続できるかを確かめる。 */
  checkConnection: ConnectionChecker;
  /** 独自エンドポイントのモデル一覧を取る。 */
  listModels: ProviderModelLister;
};

export function createApiHandlers(deps: ApiDeps) {
  const { store, settings } = deps;

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

    const providerId = modelProvider(model);
    const modelId = model.slice(providerId.length + 1);
    const entry = snapshot.models.get(providerId)?.find((candidate) => candidate.id === modelId) ?? null;

    return Response.json({
      model,
      effort: settings.read().modelOptions[model]?.reasoningEffort ?? null,
      values: selectableEfforts(providerId, entry),
    } satisfies ReasoningView);
  }

  return {
    listSessions(): Response {
      return Response.json({ sessions: store.listSessions() });
    },

    deleteSession(req: ApiRequest<{ id: string }>): Response {
      if (!store.deleteSession(req.params.id)) {
        return jsonError(404, "session_not_found");
      }
      return new Response(null, { status: 204 });
    },

    listMessages(req: ApiRequest<{ id: string }>): Response {
      if (store.getSession(req.params.id) === null) {
        return jsonError(404, "session_not_found");
      }
      return Response.json({ messages: store.listMessages(req.params.id) });
    },

    /**
     * ユーザー発言を保存し、そのターンの応答を SSE で流す。
     * セッションはクライアントが生成した id で、初回送信時にここで作られる。
     */
    async sendMessage(req: ApiRequest<{ id: string }>): Promise<Response> {
      const body = await readJsonBody(req);
      const raw = typeof body?.["content"] === "string" ? body["content"] : "";
      const content = raw.trim();
      if (content.length === 0) {
        return jsonError(400, "invalid_request", "content must be a non-empty string");
      }

      // モデルを呼べない状態なら、セッションも作らずに理由を返す。
      // 呼び出しの中で初めて失敗すると、画面には「モデルから応答を得られませんでした」としか出せない。
      const resolution = resolveModel(settings.read());
      if (!resolution.ok) {
        return jsonError(400, "model_not_configured", resolution.detail);
      }

      return sseResponse(runTurn(deps, req.params.id, content, req.signal));
    },

    /** 設定画面を開いたときに読む、モデル設定の全体。 */
    readModelSettings(): Response {
      return currentView();
    },

    /** 既定のモデルを変える。設定済みのプロバイダのモデルしか受け付けない。 */
    async setDefaultModel(req: PlainRequest): Promise<Response> {
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
    async setReasoning(req: PlainRequest): Promise<Response> {
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
        const providerId = modelProvider(model);
        const modelId = model.slice(providerId.length + 1);
        const entry = snapshot.models.get(providerId)?.find((candidate) => candidate.id === modelId) ?? null;
        const values = selectableEfforts(providerId, entry);

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
    async checkProvider(req: PlainRequest): Promise<Response> {
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
    async addProvider(req: PlainRequest): Promise<Response> {
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
      const merged: ProviderCredentials = { ...credentials, apiKey: credentials.apiKey ?? existing.apiKey ?? null };

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

    /** MCP サーバーを追加する。接続の確認は追加の後で行う（OAuth は保存済みの設定が要る）。 */
    async addMcpServer(req: PlainRequest): Promise<Response> {
      const parsed = await readMcpForm(req);
      if (parsed instanceof Response) return parsed;

      if (settings.readMcp().servers[parsed.id] !== undefined) {
        return jsonError(409, "mcp_server_exists", `MCP サーバー ${parsed.id} はすでに追加されています`);
      }

      return commitMcp(() => settings.putMcpServer(parsed.id, parsed.server));
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
      if (state === null) return authorizationPage(400, "認可を確認できませんでした", ["URL に state がありません。", "Invalid callback: missing state."]);

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

  /** 保存の前後に使う接続確認。失敗した場合はそのまま返せるレスポンスを返す。 */
  async function verifyProvider(
    id: string,
    provider: ProviderSettings,
    signal: AbortSignal,
  ): Promise<ConnectionResult | Response> {
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

/** 設定から画面用の形を作る。名前は label があればそれ、無ければ id（カタログの名前はクライアントが当てる）。 */
function toSettingsView(settings: ModelSettings): ModelSettingsView {
  return {
    model: settings.model,
    providers: Object.entries(settings.providers).map(([id, provider]) => ({
      id,
      name: provider.label ?? id,
      baseUrl: provider.baseUrl ?? null,
      hasApiKey: provider.apiKey !== undefined,
    })),
  };
}

/** MCP サーバーの設定を、画面に出す形にする。接続状態は manager が持っているものを当てる。 */
function toMcpView(servers: McpServersSettings, mcp: McpManager): McpServersView {
  return {
    servers: Object.entries(servers).map(([id, server]) => ({
      id,
      type: server.type,
      command: server.type === "stdio" ? server.command : null,
      args: server.type === "stdio" ? (server.args ?? []) : [],
      env: server.type === "stdio" ? (server.env ?? {}) : {},
      url: server.type === "http" ? server.url : null,
      oauth: server.type === "http" && server.oauth === true,
      status: mcp.status(id),
    })),
  };
}

/** 画面から来た MCP サーバーの入力。id と種類の食い違いは保存の前に弾く。 */
async function readMcpForm(
  req: { json(): Promise<unknown> },
): Promise<{ id: string; server: McpServerSettings } | Response> {
  const body = await readJsonBody(req);

  const rawId = body?.["id"];
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!isMcpServerId(id)) {
    return jsonError(400, "invalid_request", "id は英小文字・数字・ハイフンで指定してください");
  }

  const type = body?.["type"];
  if (type !== "stdio" && type !== "http") {
    return jsonError(400, "invalid_request", 'type は "stdio" か "http" にしてください');
  }

  const command = readOptionalString(body, "command");
  const url = readOptionalString(body, "url");
  const args = readOptionalStringList(body, "args");
  const env = readOptionalStringMap(body, "env");
  const oauth = body?.["oauth"] ?? false;
  if (command === undefined || url === undefined || args === undefined || env === undefined) {
    return jsonError(400, "invalid_request", "command, url, args, env は文字列・文字列の配列・文字列の対応表で指定してください");
  }
  if (typeof oauth !== "boolean") {
    return jsonError(400, "invalid_request", "oauth は true か false で指定してください");
  }

  const form: McpServerForm = { id, type, command, args, env, url, oauth };

  try {
    return { id, server: mcpServerSettingsFromForm(form, `mcpServers.${id}`) };
  } catch (error) {
    return jsonError(400, "invalid_request", describeError(error));
  }
}

/** 認可の結果をブラウザに出す 1 枚のページ。サーバを言語非依存に保つため日英を併記する。 */
function authorizationPage(status: number, title: string, lines: readonly string[]): Response {
  const paragraphs = lines
    .map((line) => `<p style="margin:.4rem 0;font-size:.9rem;color:#404040">${escapeHtml(line)}</p>`)
    .join("");

  const html = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Terasuma</title></head>
<body style="margin:0;padding:3rem 1.5rem;font-family:system-ui,-apple-system,sans-serif;line-height:1.7;color:#171717;background:#fafafa">
<main style="max-width:32rem;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:1.5rem 1.75rem">
<h1 style="margin:0 0 .5rem;font-size:1.05rem">${escapeHtml(title)}</h1>
${paragraphs}
</main>
</body></html>`;

  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
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

/** リクエストからプロバイダ id を読む。 */
function readProviderId(body: Record<string, unknown> | null): string | null {
  const id = body?.["id"];
  if (typeof id !== "string") return null;

  const trimmed = id.trim();
  return isProviderId(trimmed) ? trimmed : null;
}

/** リクエストから接続情報（apiKey / baseUrl / label）を読む。 */
function readCredentials(body: Record<string, unknown> | null): ProviderCredentials | null {
  const apiKey = readOptionalString(body, "apiKey");
  const baseUrl = readOptionalString(body, "baseUrl");
  const label = readOptionalString(body, "label");
  if (apiKey === undefined || baseUrl === undefined || label === undefined) return null;

  return { apiKey, baseUrl, label };
}

/** 追加と同時に決める既定のモデル。文字列でない値は弾く。 */
function readDefaultModel(body: Record<string, unknown> | null): ModelId | null | Response {
  const value = body?.["defaultModel"];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isModelId(value)) {
    return jsonError(400, "invalid_request", 'defaultModel must be a "provider/model" string or null');
  }
  return value;
}

/** 未入力（null / 無し）は null、文字列はそのまま、それ以外は undefined を返す。 */
function readOptionalString(body: Record<string, unknown> | null, key: string): string | null | undefined {
  const value = body?.[key];
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** 未入力（null / 無し）は null、文字列の配列はそのまま、それ以外は undefined を返す。 */
function readOptionalStringList(
  body: Record<string, unknown> | null,
  key: string,
): readonly string[] | null | undefined {
  const value = body?.[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value as string[];
}

/** 未入力（null / 無し）は null、文字列→文字列の対応表はそのまま、それ以外は undefined を返す。 */
function readOptionalStringMap(
  body: Record<string, unknown> | null,
  key: string,
): Record<string, string> | null | undefined {
  const value = body?.[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;

  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entry]) => typeof entry === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * リクエストの本文から接続情報を読み、検証して保存できる形にする。
 * 弾いた場合はそのまま返せる 400 のレスポンスを返す。
 */
function parseProviderSettings(
  id: string,
  body: Record<string, unknown> | null,
): ProviderSettings | Response {
  const credentials = readCredentials(body);
  if (credentials === null) {
    return jsonError(400, "invalid_request", "apiKey, baseUrl, label must be strings or null");
  }

  try {
    return normalizeProvider(id, providerSettingsFromForm(credentials), `providers.${id}`);
  } catch (error) {
    return jsonError(400, "invalid_request", describeError(error));
  }
}

/**
 * 1 ターン分のイベント列。
 * 保存 → モデル呼び出し → 保存、の順で進み、履歴は常に追記だけになる。
 */
async function* runTurn(
  deps: ApiDeps,
  sessionId: string,
  content: string,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const { store, engine } = deps;

  store.ensureSession(sessionId, content);
  const userMessage = store.appendMessage({
    id: crypto.randomUUID(),
    sessionId,
    role: "user",
    content,
  });
  yield { type: "user-message", message: userMessage };

  const assistantId = crypto.randomUUID();
  yield { type: "assistant-start", id: assistantId, createdAt: Date.now() };

  // 保存済み履歴をそのまま渡す。要約も並べ替えもしない
  // （プロンプトキャッシュが当たり続けるようにするため）。
  const history = store.listMessages(sessionId);

  /** 生成中の本文とツールの出来事。保存される並びそのものになる。 */
  const parts: MessagePart[] = [];
  let usage: TokenUsage | null = null;
  let failure: string | null = null;
  let finalMessage: ChatMessage | null = null;

  const appendText = (delta: string): void => {
    const last = parts.at(-1);
    if (last?.type === "text") last.text += delta;
    else parts.push({ type: "text", text: delta });
  };

  /** ツールを使わなかったターンは、本文だけを持つ（parts 無し）メッセージにする。 */
  const storedParts = (): MessagePart[] | null => (parts.some((part) => part.type !== "text") ? parts : null);
  const storedText = (): string =>
    parts
      .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");

  /**
   * 生成済みの内容は、正常終了でも「停止」でも必ず保存する。
   * 停止時は呼び出し元がジェネレータを return するため、yield を含む後続のコードは実行されない。
   * だから保存だけは finally から呼べる形に切り出してある。
   * 何も生成しないまま失敗したときだけ、空のメッセージを作らない。
   */
  const persist = (): void => {
    if (finalMessage !== null) return;
    if (parts.length === 0 && failure !== null) return;

    finalMessage = store.appendMessage({
      id: assistantId,
      sessionId,
      role: "assistant",
      content: storedText(),
      parts: storedParts(),
      usage,
    });
  };

  try {
    const stream = await engine.stream({ history, signal });

    for await (const event of stream.events) {
      switch (event.type) {
        case "text-delta":
          appendText(event.delta);
          yield { type: "text-delta", id: assistantId, delta: event.delta };
          break;
        case "tool-call":
          parts.push(event.part);
          yield { type: "tool-call", id: assistantId, part: event.part };
          break;
        case "tool-result":
          parts.push(event.part);
          yield { type: "tool-result", id: assistantId, part: event.part };
          break;
      }
    }

    usage = await stream.usage;
  } catch (error) {
    failure = describeError(error);
  } finally {
    persist();
  }

  if (failure === null && finalMessage !== null) {
    yield { type: "assistant-done", message: finalMessage };
    return;
  }

  // クライアントが離脱済みなら届け先が無いのでイベントにしない。
  if (failure !== null && !signal.aborted) {
    yield { type: "error", code: "model_error", detail: failure };
  }
}

/**
 * クライアントが読むたびに、次のイベントを 1 つずつ返す。
 * pull ベースなので、相手が読まなくなれば cancel が呼ばれ、生成側も止まる。
 */
function sseResponse(events: AsyncGenerator<ChatEvent>): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(encodeChatEvent(next.value)));
    },
    async cancel() {
      await events.return(undefined);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/** 本文が無い・JSON でない場合は「本文なし」として扱い、呼び出し側で invalid_request にする。 */
async function readJsonBody(req: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

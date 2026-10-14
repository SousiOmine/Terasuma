import {
  isProviderId,
  normalizeProvider,
  providerSettingsFromForm,
  type ModelSettings,
  type ProviderSettings,
} from "../config";
import { isModelId, modelProvider, type ModelId } from "../shared/model";
import { findProviderCatalogEntry } from "../shared/providers";
import { encodeChatEvent } from "../shared/sse";
import type {
  ChatEvent,
  ChatMessage,
  ModelSettingsView,
  ProviderCredentials,
  TokenUsage,
} from "../shared/types";
import { resolveModel, type AgentEngine } from "./engine";
import { describeError, jsonError } from "./errors";
import { ProviderRequestError, type ProviderAccess, type ProviderModelLister } from "./provider-models";
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
  /** プロバイダのモデル一覧を取ってくる関数（接続確認を兼ねる）。 */
  listModels: ProviderModelLister;
};

export function createApiHandlers(deps: ApiDeps) {
  const { store, settings, listModels } = deps;

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

  return {
    listSessions(): Response {
      return Response.json({ sessions: store.listSessions() });
    },

    async renameSession(req: ApiRequest<{ id: string }>): Promise<Response> {
      const body = await readJsonBody(req);
      const title = typeof body?.["title"] === "string" ? body["title"] : null;
      if (title === null) return jsonError(400, "invalid_request", "title must be a string");

      if (!store.renameSession(req.params.id, title)) {
        return jsonError(404, "session_not_found");
      }
      return Response.json({ session: store.getSession(req.params.id) });
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
     * 保存せずに接続だけを確かめる。追加ウィザードが、モデルを選ばせる前の一覧取得に使う。
     */
    async checkProvider(req: PlainRequest): Promise<Response> {
      const body = await readJsonBody(req);
      const id = readProviderId(body);
      if (id === null) return jsonError(400, "invalid_request", "id must be a provider id");

      const provider = parseProviderSettings(id, body);
      if (provider instanceof Response) return provider;

      return listModelsResponse(listModels, { id, ...accessOf(id, provider) }, req.signal);
    },

    /**
     * プロバイダを追加する。保存の前に必ず接続を確かめるので、
     * 設定に入っているプロバイダは常に「到達確認済み」になる。
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

      const failure = await verifyProvider(listModels, id, provider, req.signal);
      if (failure !== null) return failure;

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

      const failure = await verifyProvider(listModels, id, provider, req.signal);
      if (failure !== null) return failure;

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

    /** 設定済みのプロバイダで使えるモデルの一覧。既定のモデルを選び直すときに使う。 */
    async listProviderModels(req: ApiRequest<{ id: string }>): Promise<Response> {
      const id = req.params.id;
      const provider = settings.read().providers[id];
      if (provider === undefined) {
        return jsonError(404, "provider_not_found", `プロバイダ ${id} は設定されていません`);
      }

      return listModelsResponse(listModels, { id, ...accessOf(id, provider) }, req.signal);
    },
  };
}

/** 設定から画面用の形を作る。 */
function toSettingsView(settings: ModelSettings): ModelSettingsView {
  return {
    model: settings.model,
    providers: Object.entries(settings.providers).map(([id, provider]) => ({
      id,
      name: provider.label ?? findProviderCatalogEntry(id)?.name ?? id,
      baseUrl: provider.baseUrl ?? null,
      hasApiKey: provider.apiKey !== undefined,
    })),
  };
}

/** 保存済み・保存前の設定から、接続確認に渡す値を取り出す。 */
function accessOf(id: string, provider: ProviderSettings): Omit<ProviderAccess, "id"> {
  return {
    apiKey: provider.apiKey ?? null,
    // カタログに既定のベース URL があるものは、利用者が入れなかったときにそれを使う（Ollama など）。
    baseUrl: provider.baseUrl ?? defaultBaseUrlOf(id),
  };
}

function defaultBaseUrlOf(id: string): string | null {
  const entry = findProviderCatalogEntry(id);
  return entry?.kind === "openai-compatible" ? entry.defaultBaseUrl : null;
}

/**
 * 保存の前に接続を確かめる。
 * 通らなかった場合はそのまま返せるレスポンスを返し、通った場合は null を返す。
 */
async function verifyProvider(
  listModels: ProviderModelLister,
  id: string,
  provider: ProviderSettings,
  signal: AbortSignal,
): Promise<Response | null> {
  try {
    await listModels({ id, ...accessOf(id, provider) }, signal);
    return null;
  } catch (error) {
    return providerFailureResponse(error);
  }
}

/** モデル一覧の取得を API のレスポンスにする。 */
async function listModelsResponse(
  listModels: ProviderModelLister,
  access: ProviderAccess,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return Response.json({ models: await listModels(access, signal) });
  } catch (error) {
    return providerFailureResponse(error);
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

  let text = "";
  let usage: TokenUsage | null = null;
  let failure: string | null = null;
  let finalMessage: ChatMessage | null = null;

  /**
   * 生成済みの本文は、正常終了でも「停止」でも必ず保存する。
   * 停止時は呼び出し元がジェネレータを return するため、yield を含む後続のコードは実行されない。
   * だから保存だけは finally から呼べる形に切り出してある。
   * 本文が無いまま失敗したときだけ、空のメッセージを作らない。
   */
  const persist = (): void => {
    if (finalMessage !== null) return;
    if (text.length === 0 && failure !== null) return;

    finalMessage = store.appendMessage({
      id: assistantId,
      sessionId,
      role: "assistant",
      content: text,
      usage,
    });
  };

  try {
    const stream = await engine.stream({ history, signal });
    for await (const delta of stream.textStream) {
      text += delta;
      yield { type: "text-delta", id: assistantId, delta };
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

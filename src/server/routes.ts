import { encodeChatEvent } from "../shared/sse";
import type { ChatEvent, ChatMessage, TokenUsage } from "../shared/types";
import type { AgentEngine } from "./engine";
import { describeError, jsonError } from "./errors";
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

export type ApiDeps = {
  store: Store;
  engine: AgentEngine;
};

export function createApiHandlers(deps: ApiDeps) {
  const { store, engine } = deps;

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

      return sseResponse(runTurn(deps, req.params.id, content, req.signal));
    },
  };
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
async function readJsonBody(
  req: ApiRequest<Record<string, string>>,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

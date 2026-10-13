import { decodeChatEvents } from "../shared/sse";
import type { ApiErrorCode, ChatEvent, ChatMessage, Session } from "../shared/types";

/** サーバが返すコードに、クライアント側だけで発生する "network" を足したもの。 */
export type ClientErrorCode = ApiErrorCode | "network";

const API_ERROR_CODES: readonly ApiErrorCode[] = [
  "invalid_request",
  "session_not_found",
  "model_error",
  "internal_error",
];

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly detail: string | null;

  constructor(code: ClientErrorCode, detail: string | null = null) {
    super(detail ?? code);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

export async function listSessions(): Promise<readonly Session[]> {
  const body = await request<{ sessions: Session[] }>("/api/sessions");
  return body.sessions;
}

export async function listMessages(sessionId: string): Promise<readonly ChatMessage[]> {
  const body = await request<{ messages: ChatMessage[] }>(messagesPath(sessionId));
  return body.messages;
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await request<unknown>(sessionPath(sessionId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(sessionPath(sessionId), { method: "DELETE" });
  } catch (error) {
    throw new ApiError("network", describe(error));
  }

  if (!response.ok) throw await toApiError(response);
}

/**
 * 1 ターン分のイベントを SSE として受け取る。
 * 途中で AbortSignal が立った場合は、例外にせずそのまま終了する（利用者の「停止」操作）。
 */
export async function* streamTurn(
  sessionId: string,
  content: string,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  let response: Response;
  try {
    response = await fetch(messagesPath(sessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw new ApiError("network", describe(error));
  }

  if (!response.ok) throw await toApiError(response);
  if (response.body === null) throw new ApiError("internal_error", "response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const { events, rest } = decodeChatEvents(buffer);
      buffer = rest;
      for (const event of events) yield event;
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function sessionPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

function messagesPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/messages`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError("network", describe(error));
  }

  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown };
    const code: ClientErrorCode = isApiErrorCode(body.code) ? body.code : "internal_error";
    const detail = typeof body.detail === "string" ? body.detail : `HTTP ${response.status}`;
    return new ApiError(code, detail);
  } catch {
    // 本文が JSON でない場合（404 のプレーンテキストなど）
    return new ApiError("internal_error", `HTTP ${response.status}`);
  }
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

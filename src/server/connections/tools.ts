import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { describeError } from "../../shared/errors";
import { truncateText } from "../../shared/text";
import { sendRequest } from "../http/client";
import { APP_REQUEST_TOOL_NAME, CONNECT_APP_TOOL_NAME } from "../../shared/tools";
import { ConnectionNotFound } from "../errors";
import type { ConnectionsManager } from "./manager";

/**
 * アプリの接続を扱うツール。
 *
 * computer_connect_app はチャットに接続カードを出し、ユーザーがトークンを保存するまで待つ。
 * app_request は接続済みのトークンで API を叩く（トークンはモデルに渡さない）。
 * どちらもツール一覧には載せず、tool_search で見つけて tool_call で実行する。
 */

/** モデルへ渡すツール。キーは "computer_connect_app" と "app_request"。 */
export type ConnectionToolset = ToolSet;

/** ツールの供給元。 */
export type ConnectionToolsetProvider = {
  toolset(): ConnectionToolset;
};

/** API 1 回の待ち時間。応答しないサーバーでターンを止めない。 */
const API_TIMEOUT_MS = 30_000;

/** モデルへ返す応答の上限（文字数）。 */
const MAX_RESPONSE_CHARS = 20_000;

type ToolContext = { abortSignal?: AbortSignal };

/** API の引数。method はスキーマの列挙より広い string として受ける。 */
type AppRequestInput = {
  provider: string;
  method: string;
  path: string;
  body?: unknown;
};

export function createConnectionToolset(connections: ConnectionsManager): ConnectionToolsetProvider {
  return {
    toolset() {
      return createConnectionTools({ connections });
    },
  };
}

export function createConnectionTools(options: { connections: ConnectionsManager }): ConnectionToolset {
  const { connections } = options;
  const appIds = connections.ids();
  const appList = appIds.join(", ");
  const firstApp = appIds[0] ?? "github";

  return {
    [CONNECT_APP_TOOL_NAME]: tool({
      description: [
        "Connect an app to the computer by having the user paste a token.",
        "Call this when a task needs the app and its environment variable is not set.",
        "A card opens in the chat with a link to create the token and a field to paste it.",
        "You never see the token. Once this returns, the token is available to every command in the computer.",
      ].join(" "),
      inputSchema: z.object({
        provider: z.string().min(1).describe(`App to connect (${appList}).`),
        reason: z.string().min(1).describe("Why you need it, written for the user to read"),
      }),
      execute: async ({ provider }: { provider: string }, context: ToolContext) => {
        const signal = context.abortSignal;
        if (signal === undefined) {
          throw new Error("Cannot wait for the user because the turn's abort signal is not available");
        }

        try {
          return await connections.wait(provider, signal);
        } catch (error) {
          if (error instanceof ConnectionNotFound) {
            throw new Error(`Unknown app "${provider}". Use one of: ${appList}.`, { cause: error });
          }
          throw error;
        }
      },
    }),

    [APP_REQUEST_TOOL_NAME]: tool({
      description: [
        "Call the API of a connected app with its saved token.",
        "Use tool_search to find this when you need the API instead of the CLI.",
        'path must begin with "/" and stay on the app\'s API, for example "/user" or "/repos/{owner}/{repo}".',
        "The token is never returned. A 401 means the user must connect the app again.",
      ].join(" "),
      inputSchema: z.object({
        provider: z.string().min(1).describe(`Connected app id (${appList}), for example "${firstApp}"`),
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method"),
        path: z.string().min(1).describe('API path beginning with "/", for example "/user"'),
        body: z.unknown().optional().describe("JSON body for POST, PATCH or PUT"),
      }),
      execute: async ({ provider, method, path, body }: AppRequestInput, context: ToolContext) => {
        const definition = providerOf(connections, provider, appList);
        const token = connections.token(provider);
        if (token === null) {
          throw new Error(
            `${definition.name} is not connected. Call ${CONNECT_APP_TOOL_NAME} and let the user paste a token first.`,
          );
        }

        const url = apiUrl(definition.api.baseUrl, path);
        const headers: Record<string, string> = {
          ...definition.api.headers,
          Authorization: `Bearer ${token}`,
        };

        // GET と DELETE に本文は付けない（付けるとサーバーによっては拒否される）。
        const withBody = body !== undefined && method !== "GET" && method !== "DELETE";
        if (withBody) headers["Content-Type"] = "application/json";

        const outcome = await sendRequest(
          fetch,
          url.toString(),
          {
            method,
            headers,
            ...(withBody ? { body: JSON.stringify(body) } : {}),
          },
          {
            timeoutMs: API_TIMEOUT_MS,
            ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          },
        );

        if (outcome.kind === "network") {
          throw new Error(`Could not reach ${definition.name}: ${describeError(outcome.error)}`, {
            cause: outcome.error,
          });
        }

        const response = outcome.response;

        const text = await response.text();
        if (response.status === 401) {
          throw new Error(
            `${definition.name} rejected the saved token. Ask the user to save a new one with ${CONNECT_APP_TOOL_NAME}.`,
          );
        }

        const status = `HTTP ${response.status}`;
        return text.length === 0 ? status : `${status}\n${truncateText(text, MAX_RESPONSE_CHARS, "marked")}`;
      },
    }),
  };
}

/** 知らない id は、モデルが読める英語の理由にする。 */
function providerOf(connections: ConnectionsManager, id: string, appList: string) {
  try {
    return connections.provider(id);
  } catch (error) {
    if (error instanceof ConnectionNotFound) {
      throw new Error(`Unknown app "${id}". Use one of: ${appList}.`, { cause: error });
    }
    throw error;
  }
}

/** API の URL を組み立てる。接続先の外へ出るパスは受け付けない。 */
function apiUrl(baseUrl: string, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error('path must begin with a single "/"');
  }

  const base = baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  if (url.origin !== new URL(base).origin) {
    throw new Error("path must stay on the connected app's API");
  }
  return url;
}

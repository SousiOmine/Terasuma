import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { describeError } from "../../shared/errors";
import { truncateText } from "../../shared/text";
import { sendRequestOrThrow } from "../http/client";
import { APP_REQUEST_TOOL_NAME, connectAppToolName } from "../../shared/tools";
import { ConnectorNotFound } from "../errors";
import { COMPOSIO_CONNECTOR_ID, createComposioTools } from "./composio";
import type { ConnectorsManager } from "./manager";
import type { ConnectorProvider } from "./providers";
import { reasonInputSchema, requireSignal, type ToolContext } from "../tools/context";

/**
 * コネクタを扱うツール。
 *
 * アプリごとの接続ツール（app_connect_<id>）はチャットにコネクタのカードを出し、
 * ユーザーがトークンかプログラムの設定を保存するまで待つ。
 * app_request は接続済みのトークンで API を叩く（トークンはモデルに渡さない）。
 * Composio だけはアプリが 1,600 以上あるので、接続ツールの代わりに検索と実行の 2 つを持つ。
 * どれもツール一覧には載せず、tool_search で見つけて tool_call で実行する。
 */

/** モデルへ渡すツール。キーは "app_connect_<id>"、"app_request"、Composio の 2 つ。 */
export type ConnectorToolset = ToolSet;

/** ツールの供給元。 */
export type ConnectorToolsetProvider = {
  toolset(): ConnectorToolset;
};

/** API 1 回の待ち時間。応答しないサーバーでターンを止めない。 */
const API_TIMEOUT_MS = 30_000;

/** モデルへ返す応答の上限（文字数）。 */
const MAX_RESPONSE_CHARS = 20_000;


/** API の引数。method はスキーマの列挙より広い string として受ける。 */
type AppRequestInput = {
  provider: string;
  method: string;
  path: string;
  body?: unknown;
};

export function createConnectorToolset(connectors: ConnectorsManager): ConnectorToolsetProvider {
  return {
    toolset() {
      return createConnectorTools({ connectors });
    },
  };
}

/** 接続ツールの説明。定義の name / needs / usage から組み立てる。 */
function connectDescription(provider: ConnectorProvider): string {
  return [
    `Connect ${provider.name}. It needs ${provider.needs}.`,
    "Call this when a task needs it and it is not connected yet.",
    "A card opens in the chat; the user fills it in and you never see the secret values.",
    `After it returns, the app is ready. ${provider.usage}`,
  ].join(" ");
}

export function createConnectorTools(options: { connectors: ConnectorsManager }): ConnectorToolset {
  const { connectors } = options;
  const providers = connectors.ids().map((id) => connectors.provider(id));
  const appIds = providers.map((provider) => provider.id);
  const appList = appIds.join(", ");
  const firstApp = appIds[0] ?? "github";

  const connectTools = Object.fromEntries(
    providers.map((provider) => [
      connectAppToolName(provider.id),
      tool({
        description: connectDescription(provider),
        inputSchema: reasonInputSchema,
        execute: async (_input: { reason: string }, context: ToolContext) => {
          // 中断を受け取れないと、ユーザーを待ったままターンを片付けられなくなる。
          const signal = requireSignal(context);

          try {
            return await connectors.wait(provider.id, signal);
          } catch (error) {
            if (error instanceof ConnectorNotFound) {
              throw new Error(`Unknown app "${provider.id}".`);
            }
            throw error;
          }
        },
      }),
    ]),
  );

  return {
    ...connectTools,
    ...(appIds.includes(COMPOSIO_CONNECTOR_ID) ? createComposioTools({ connectors }) : {}),

    [APP_REQUEST_TOOL_NAME]: tool({
      description: [
        "Call the API of a connected app with its saved token.",
        "Use tool_search to find this when you need the API instead of the CLI.",
        'path must begin with "/" and stay on the app\'s API, for example "/user" or "/repos/{owner}/{repo}".',
        "The token is never returned. A 401 means the saved token was rejected: ask the user to save it again.",
      ].join(" "),
      inputSchema: z.object({
        provider: z.string().min(1).describe(`Connected app id (${appList}), for example "${firstApp}"`),
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method"),
        path: z.string().min(1).describe('API path beginning with "/", for example "/user"'),
        body: z.unknown().optional().describe("JSON body for POST, PATCH or PUT"),
      }),
      execute: async ({ provider, method, path, body }: AppRequestInput, context: ToolContext) => {
        const definition = providerOf(connectors, provider, appList);
        if (definition.kind !== "token") {
          throw new Error(`${definition.name} has no API. Run it inside the computer instead.`);
        }

        const token = connectors.token(provider);
        if (token === null) {
          throw new Error(
            `${definition.name} is not connected. Call ${connectAppToolName(provider)} and let the user fill in the card first.`,
          );
        }

        const url = apiUrl(definition.api.baseUrl, path);
        const { header, prefix } = definition.api.auth;
        const headers: Record<string, string> = {
          ...definition.api.headers,
          [header]: `${prefix}${token}`,
        };

        // GET と DELETE に本文は付けない（付けるとサーバーによっては拒否される）。
        const withBody = body !== undefined && method !== "GET" && method !== "DELETE";
        if (withBody) headers["Content-Type"] = "application/json";

        const response = await sendRequestOrThrow(
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
            onNetwork: (error) =>
              new Error(`Could not reach ${definition.name}: ${describeError(error)}`, { cause: error }),
          },
        );

        const text = await response.text();
        if (response.status === 401) {
          throw new Error(
            `${definition.name} rejected the saved token. Ask the user to save a new one with ${connectAppToolName(provider)}.`,
          );
        }

        const status = `HTTP ${response.status}`;
        return text.length === 0 ? status : `${status}\n${truncateText(text, MAX_RESPONSE_CHARS, "marked")}`;
      },
    }),
  };
}

/** 知らない id は、モデルが読める英語の理由にする。 */
function providerOf(connectors: ConnectorsManager, id: string, appList: string) {
  try {
    return connectors.provider(id);
  } catch (error) {
    if (error instanceof ConnectorNotFound) {
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

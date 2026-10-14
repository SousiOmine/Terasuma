import { join } from "node:path";
import type { Tool } from "@mastra/core/tools";
import type { MastraMCPServerDefinition } from "@mastra/mcp";
import { MCPClient } from "@mastra/mcp";
import type { McpHttpServerSettings, McpServerSettings, McpServersSettings } from "../config";
import type { McpAuthorizationView, McpServerStatusView } from "../shared/types";
import {
  McpOAuthProvider,
  createFileOAuthStorage,
  finishMcpAuthorization,
  serverIdFromState,
  startMcpAuthorization,
  type OAuthStorage,
} from "./mcp-oauth";
import type { SettingsStore } from "./settings";

/** モデルへ渡すツール。キーは "<サーバー id>_<ツール名>"。 */
export type McpToolset = Record<string, Tool<any, any, any, any>>;

/** 設定に無い MCP サーバーを触ろうとしたときの失敗。 */
export class McpServerNotFound extends Error {
  constructor(readonly serverId: string) {
    super(`MCP サーバー ${serverId} は設定されていません`);
    this.name = "McpServerNotFound";
  }
}

/** 認可の開始・完了で受け取った値。 */
export type AuthorizationCallback = {
  /** 認可コード。拒否された場合は null。 */
  code: string | null;
  /** 認可サーバーが返した iss（RFC 9207）。無ければ null。 */
  iss: string | null;
  /** 認可サーバーが返したエラー。無ければ null。 */
  error: string | null;
};

export type McpManager = {
  /** いま分かっている接続状態（接続はしない）。 */
  status(serverId: string): McpServerStatusView;
  /** 接続して状態とツールを取り直す。 */
  check(serverId: string): Promise<McpServerStatusView>;
  /** モデルへ渡すツール。設定が変わっていれば作り直してから返す。 */
  toolset(): Promise<McpToolset>;
  /** OAuth の認可を始める。開く URL を返す（すでに認可済みなら null）。 */
  authorize(serverId: string): Promise<McpAuthorizationView>;
  /** 待っている認可を取り消す。次に接続を確かめたときの結果に戻る。 */
  cancelAuthorization(serverId: string): void;
  /** コールバックで受け取ったコードをトークンに交換する。 */
  completeAuthorization(state: string, callback: AuthorizationCallback): Promise<{ serverId: string }>;
  /** 接続と子プロセスを片付ける。 */
  close(): Promise<void>;
};

export type McpManagerOptions = {
  settings: SettingsStore;
  /** OAuth の保存先を置くディレクトリ。 */
  dataDir: string;
  /**
   * 認可コードを受け取る URL。待ち受けを始めるまで決まらないので、呼び出しのたびに読む。
   * まだ決まっていないときに認可を始めようとしたら失敗させる（登録先が食い違う URL で登録しないため）。
   */
  callbackUrl: () => URL | null;
};

/** OAuth の保存先を置くディレクトリ名。 */
const OAUTH_DIR_NAME = "mcp-oauth";

/** 1 サーバー分の探索の打ち切り。繋がらないサーバーで画面を待たせ続けない。 */
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * MCP サーバーとの接続を持つ。
 *
 * サーバーごとの接続（ローカルの子プロセス起動・HTTP・OAuth）とツールの変換は
 * Mastra の MCPClient に任せ、ここでは次の 2 つだけを決める。
 *
 * - いつ接続を作り直すか（設定が変わったときと、接続を確かめるときだけ）
 * - モデルへ渡すときのツール名（"<サーバー id>_<ツール名>"）
 *
 * チャットのたびに接続を試みないのは、落ちているサーバーがあると毎回そこで待たされるため。
 */
export function createMcpManager(options: McpManagerOptions): McpManager {
  const { settings } = options;

  let client: MCPClient | null = null;
  /** クライアントを作ったときのサーバー設定（JSON）。これが変わったら作り直す。 */
  let clientKey = "";
  /** サーバー id → いま分かっている状態。 */
  let statuses = new Map<string, McpServerStatusView>();
  /** モデルへ渡すツール。 */
  let tools: McpToolset = {};
  /** 一度でも探索したかどうか。 */
  let discovered = false;
  /** 認可を待っているサーバー（id → 認可画面の URL）。 */
  const pending = new Map<string, string>();

  function storageFor(serverId: string): OAuthStorage {
    return createFileOAuthStorage(join(options.dataDir, OAUTH_DIR_NAME, `${serverId}.json`));
  }

  function callbackUrl(): URL {
    const url = options.callbackUrl();
    if (url === null) throw new Error("認可コードの受け取り先がまだ決まっていません");
    return url;
  }

  function definition(serverId: string, server: McpServerSettings): MastraMCPServerDefinition {
    if (server.type === "stdio") {
      return {
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
      };
    }

    const definition: Extract<MastraMCPServerDefinition, { url: URL }> = { url: new URL(server.url) };
    if (server.oauth === true) {
      definition.authProvider = new McpOAuthProvider({
        serverId,
        redirectUrl: callbackUrl(),
        storage: storageFor(serverId),
      });
    }
    return definition;
  }

  /** 設定に対応するクライアントを返す。設定が変わっていれば前のものを閉じて作り直す。 */
  async function ensureClient(servers: McpServersSettings): Promise<MCPClient> {
    const key = JSON.stringify(servers);
    if (client !== null && key === clientKey) return client;

    if (client !== null) {
      const previous = client;
      client = null;
      await previous.disconnect();
    }

    client = new MCPClient({
      // 同じ設定で複数作ると MCPClient 側が失敗するため、この manager だけの id を渡す。
      id: `terasuma-${crypto.randomUUID()}`,
      servers: Object.fromEntries(
        Object.entries(servers).map(([serverId, server]) => [serverId, definition(serverId, server)]),
      ),
      timeout: DISCOVERY_TIMEOUT_MS,
    });
    clientKey = key;
    statuses = new Map();
    tools = {};
    discovered = false;
    return client;
  }

  /** すべてのサーバーへ接続してツールを取り直し、状態を置き換える。 */
  async function refresh(servers: McpServersSettings): Promise<void> {
    const mcp = await ensureClient(servers);
    const { toolsets, errors, errorDetails } = await mcp.listToolsetsWithErrors({
      perServerTimeoutMs: DISCOVERY_TIMEOUT_MS,
    });

    // ツール名は "<サーバー id>_<ツール名>" としてモデルへ渡す。同じ名前になる組み合わせが
    // あると、どちらのサーバーのツールか決められない。決められないまま渡さず、両方を失敗にする。
    const claimed = new Map<string, string>();
    const conflicted = new Map<string, string>();
    for (const [serverId, serverTools] of Object.entries(toolsets)) {
      for (const toolName of Object.keys(serverTools)) {
        const namespaced = `${serverId}_${toolName}`;
        const owner = claimed.get(namespaced);
        if (owner === undefined) {
          claimed.set(namespaced, serverId);
        } else if (owner !== serverId) {
          conflicted.set(serverId, namespaced);
          conflicted.set(owner, namespaced);
        }
      }
    }

    const nextStatuses = new Map<string, McpServerStatusView>();
    const nextTools: McpToolset = {};

    for (const [serverId, server] of Object.entries(servers)) {
      const conflict = conflicted.get(serverId);
      if (conflict !== undefined) {
        nextStatuses.set(serverId, {
          state: "failed",
          tools: [],
          detail: `ツール名 ${conflict} が別のサーバーのツールと衝突しています（どちらかのサーバー名かツール名を変えてください）`,
        });
        continue;
      }

      const serverTools = toolsets[serverId];
      if (serverTools === undefined) {
        nextStatuses.set(serverId, {
          state: failureState(server, errorDetails[serverId]?.httpStatus),
          tools: [],
          detail: errorDetails[serverId]?.message ?? errors[serverId] ?? "接続できませんでした",
        });
        continue;
      }

      for (const [toolName, tool] of Object.entries(serverTools)) {
        nextTools[`${serverId}_${toolName}`] = tool;
      }
      nextStatuses.set(serverId, { state: "connected", tools: Object.keys(serverTools), detail: null });
    }

    statuses = nextStatuses;
    tools = nextTools;
    discovered = true;
  }

  /** 設定から MCP サーバー 1 件を取り出す。無ければ失敗させる。 */
  function requireServer(serverId: string): McpServerSettings {
    const server = settings.readMcp().servers[serverId];
    if (server === undefined) throw new McpServerNotFound(serverId);
    return server;
  }

  function requireOAuthServer(serverId: string, server: McpServerSettings): McpHttpServerSettings {
    if (server.type !== "http") {
      throw new Error(`MCP サーバー ${serverId} はローカルで動くため、認可は要りません`);
    }
    if (server.oauth !== true) {
      throw new Error(`MCP サーバー ${serverId} は OAuth を使う設定になっていません`);
    }
    return server;
  }

  return {
    status(serverId) {
      if (pending.has(serverId)) return { state: "authorizing", tools: [], detail: null };
      return statuses.get(serverId) ?? { state: "unknown", tools: [], detail: null };
    },

    async check(serverId) {
      const servers = settings.readMcp().servers;
      if (servers[serverId] === undefined) throw new McpServerNotFound(serverId);
      // 認可を待っている間は繋ぎに行かない。接続を試すと認可の要求が作り直され、
      // ブラウザで開いている URL が使えなくなる。
      if (pending.has(serverId)) return { state: "authorizing", tools: [], detail: null };

      const mcp = await ensureClient(servers);
      try {
        await mcp.reconnectServer(serverId);
      } catch {
        // 繋がらなかった理由は次の探索が必ず拾うので、ここでは重ねて報告しない。
      }

      await refresh(servers);
      return this.status(serverId);
    },

    async toolset() {
      const servers = settings.readMcp().servers;
      if (Object.keys(servers).length === 0) return {};

      await ensureClient(servers);
      if (!discovered) await refresh(servers);
      return tools;
    },

    async authorize(serverId) {
      const server = requireOAuthServer(serverId, requireServer(serverId));

      const result = await startMcpAuthorization({
        serverId,
        serverUrl: server.url,
        redirectUrl: callbackUrl(),
        storage: storageFor(serverId),
      });

      if (result.kind === "authorized") {
        pending.delete(serverId);
        return { url: null };
      }

      pending.set(serverId, result.url);
      return { url: result.url };
    },

    cancelAuthorization(serverId) {
      pending.delete(serverId);
    },

    async completeAuthorization(state, callback) {
      const serverId = serverIdFromState(state);
      if (serverId === null) throw new Error("認可の state を読めませんでした（認可をやり直してください）");

      const server = requireOAuthServer(serverId, requireServer(serverId));

      try {
        if (callback.error !== null) throw new Error(`認可が拒否されました（${callback.error}）`);
        if (callback.code === null) throw new Error("認可コードがありませんでした");

        await finishMcpAuthorization({
          serverId,
          serverUrl: server.url,
          redirectUrl: callbackUrl(),
          storage: storageFor(serverId),
          code: callback.code,
          iss: callback.iss,
        });
      } catch (error) {
        statuses.set(serverId, { state: "failed", tools: [], detail: describe(error) });
        throw error;
      } finally {
        pending.delete(serverId);
      }

      return { serverId };
    },

    async close() {
      const current = client;
      client = null;
      clientKey = "";
      if (current !== null) await current.disconnect();
    },
  };
}

/** 接続できなかったときの状態。認可が要る場合だけ区別する。 */
function failureState(server: McpServerSettings, httpStatus: number | undefined): "authorization_required" | "failed" {
  return server.type === "http" && server.oauth === true && httpStatus === 401 ? "authorization_required" : "failed";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

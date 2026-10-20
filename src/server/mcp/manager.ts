import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool as McpToolDefinition,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { McpHttpServerSettings, McpServerSettings, McpServersSettings } from "../data/settings-schema";
import { toolNameFor } from "../../shared/tools";
import type { ImageRef, McpAuthorizationView, McpServerStatusView, McpTestView } from "../../shared/types";
import {
  McpOAuthProvider,
  createFileOAuthStorage,
  finishMcpAuthorization,
  serverIdFromState,
  startMcpAuthorization,
  type OAuthStorage,
} from "./oauth";
import type { SettingsStore } from "../data/settings";
import type { ImageStore } from "../computer/images";
import type { ImageToolOutput } from "../agent/tool-output";
import { describeError } from "../../shared/errors";

/** モデルへ渡すツール。キーは "<サーバー id>_<ツール名>"。 */
export type McpToolset = ToolSet;

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
  /**
   * 保存する前に、渡された設定で繋がるか確かめる（設定には何も書かない）。
   * サーバーが認可を求めた場合は、ブラウザで開く URL を返して認可を待つ。
   */
  test(serverId: string, server: McpServerSettings): Promise<McpTestView>;
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
  /** ツールが返した画像の置き場。会話には参照だけを残す。 */
  images: ImageStore;
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

/** 1 サーバー分の接続。設定が変わったら作り直す。 */
type ServerConnection = {
  /** 接続を作ったときのサーバー設定（JSON）。変わったら作り直す。 */
  key: string;
  client: Client;
  /** 認可が必要になったときに URL を渡してくる口。stdio では null。 */
  oauth: McpOAuthProvider | null;
  /** サーバーが公開しているツール（名前空間を付ける前）。 */
  tools: readonly McpToolDefinition[];
};

/** 1 つのサーバーへ繋ぐための材料。 */
type ConnectionMaterial = {
  transport: Transport;
  oauth: McpOAuthProvider | null;
};

/**
 * MCP サーバーとの接続を持つ。
 *
 * サーバーごとの接続（ローカルの子プロセス起動・HTTP・OAuth）とツールの変換は
 * 公式 SDK の Client に任せ、ここでは次の 3 つだけを決める。
 *
 * - いつ接続を作り直すか（設定が変わったときと、接続を確かめるときだけ）
 * - モデルへ渡すときのツール名（"<サーバー id>_<ツール名>"）
 * - 接続できなかった理由を、画面に出せる状態にする
 *
 * チャットのたびに接続を試みないのは、落ちているサーバーがあると毎回そこで待たされるため。
 *
 * OAuth が要るかどうかは設定に書かない。http のサーバーには常に認可の口を渡しておき、
 * サーバーが 401 を返したときにだけ始める（要らないサーバーでは何も起きない）。
 */
export function createMcpManager(options: McpManagerOptions): McpManager {
  const { settings } = options;

  /** サーバー id → つながっている接続。 */
  let connections = new Map<string, ServerConnection>();
  /** 接続を作ったときの設定（JSON）。これが変わったら作り直す。 */
  let settingsKey: string | null = null;
  /** サーバー id → いま分かっている状態。 */
  let statuses = new Map<string, McpServerStatusView>();
  /** モデルへ渡すツール。 */
  let tools: McpToolset = {};
  /** 一度でも探索したかどうか。落ちているサーバーを毎ターン試しに行かないため。 */
  let discovered = false;
  /** 認可を待っているサーバー（id → 認可画面の URL）。 */
  const pending = new Map<string, string>();
  /** 保存前の確認で認可を待っているサーバー（id → 確かめている設定と、認可画面の URL）。 */
  const pendingTests = new Map<string, { server: McpServerSettings; url: string }>();

  function storageFor(serverId: string): OAuthStorage {
    return createFileOAuthStorage(join(options.dataDir, OAUTH_DIR_NAME, `${serverId}.json`));
  }

  function callbackUrl(): URL {
    const url = options.callbackUrl();
    if (url === null) throw new Error("認可コードの受け取り先がまだ決まっていません");
    return url;
  }

  /** 1 つのサーバーへ繋ぐための材料。 */
  function connectionFor(serverId: string, server: McpServerSettings): ConnectionMaterial {
    if (server.type === "stdio") {
      return {
        transport: new StdioClientTransport({
          command: server.command,
          ...(server.args === undefined ? {} : { args: [...server.args] }),
          ...(server.env === undefined ? {} : { env: { ...server.env } }),
        }),
        oauth: null,
      };
    }

    const oauth = new McpOAuthProvider({
      serverId,
      redirectUrl: callbackUrl(),
      storage: storageFor(serverId),
    });
    return {
      transport: new StreamableHTTPClientTransport(new URL(server.url), { authProvider: oauth }),
      oauth,
    };
  }

  /** すべての接続を閉じる。設定が変わったときと、終了するときに使う。 */
  async function closeConnections(): Promise<void> {
    const current = [...connections.values()];
    connections = new Map();
    for (const connection of current) {
      await connection.client.close().catch(() => undefined);
    }
  }

  /**
   * 設定に対応する状態に揃える。設定が変わっていれば、前の接続を閉じて状態を捨てる。
   * 接続そのものは refresh() が作る。
   */
  async function ensureConnections(servers: McpServersSettings): Promise<void> {
    const key = JSON.stringify(servers);
    if (key === settingsKey) return;

    await closeConnections();
    settingsKey = key;
    statuses = new Map();
    tools = {};
    discovered = false;
  }

  /**
   * すべてのサーバーへ接続してツールを取り直し、状態を置き換える。
   * つながっているサーバーは、設定が変わっていない限り接続を使い回す。
   */
  async function refresh(servers: McpServersSettings): Promise<void> {
    await ensureConnections(servers);

    // 設定から消えたサーバーの接続を閉じる。
    for (const serverId of [...connections.keys()]) {
      if (servers[serverId] !== undefined) continue;

      const connection = connections.get(serverId);
      connections.delete(serverId);
      if (connection !== undefined) await connection.client.close().catch(() => undefined);
    }

    for (const [serverId, server] of Object.entries(servers)) {
      const key = JSON.stringify(server);
      const existing = connections.get(serverId);
      if (existing !== undefined && existing.key === key) continue;

      if (existing !== undefined) {
        connections.delete(serverId);
        await existing.client.close().catch(() => undefined);
      }

      const material = connectionFor(serverId, server);
      const client = new Client({ name: `terasuma-${serverId}`, version: "1.0.0" });
      try {
        await client.connect(material.transport, { timeout: DISCOVERY_TIMEOUT_MS });
        const listed = await client.listTools(undefined, { timeout: DISCOVERY_TIMEOUT_MS });
        connections.set(serverId, { key, client, oauth: material.oauth, tools: listed.tools });
      } catch (error) {
        await client.close().catch(() => undefined);

        // サーバーが認可を求めたときだけ、認可の待ちとして扱う。
        // 認可の用意が無い 401 は、内部的な失敗理由を出さずに「接続できませんでした」として扱う。
        const authorizationUrl = material.oauth?.takeAuthorizationUrl() ?? null;
        statuses.set(
          serverId,
          authorizationUrl === null
            ? { state: "failed", tools: [], detail: describeError(error) }
            : { state: "authorization_required", tools: [], detail: null },
        );
        connections.delete(serverId);
      }
    }

    rebuild(servers);
    discovered = true;
  }

  /**
   * いまの接続から、状態とモデルへ渡すツールを組み直す。
   * ツール名は "<サーバー id>_<ツール名>" としてモデルへ渡す。同じ名前になる組み合わせが
   * あると、どちらのサーバーのツールか決められない。決められないまま渡さず、両方を失敗にする。
   */
  function rebuild(servers: McpServersSettings): void {
    const claimed = new Map<string, string>();
    const conflicted = new Map<string, string>();
    for (const [serverId, connection] of connections) {
      for (const definition of connection.tools) {
        const namespaced = toolNameFor(serverId, definition.name);
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

    for (const serverId of Object.keys(servers)) {
      const connection = connections.get(serverId);
      if (connection === undefined) {
        // 接続に失敗した理由は refresh() が書いている。まだ何も分からないサーバーは unknown。
        nextStatuses.set(serverId, statuses.get(serverId) ?? { state: "unknown", tools: [], detail: null });
        continue;
      }

      const conflict = conflicted.get(serverId);
      if (conflict !== undefined) {
        nextStatuses.set(serverId, {
          state: "failed",
          tools: [],
          detail: `ツール名 ${conflict} が別のサーバーのツールと衝突しています（どちらかのサーバー名かツール名を変えてください）`,
        });
        continue;
      }

      nextStatuses.set(serverId, {
        state: "connected",
        tools: connection.tools.map((definition) => definition.name),
        detail: null,
      });
      for (const [namespaced, definition] of toolEntries(serverId, connection, options.images)) {
        nextTools[namespaced] = definition;
      }
    }

    statuses = nextStatuses;
    tools = nextTools;
  }

  /** 設定から MCP サーバー 1 件を取り出す。無ければ失敗させる。 */
  function requireServer(serverId: string): McpServerSettings {
    const server = settings.read().mcpServers[serverId];
    if (server === undefined) throw new McpServerNotFound(serverId);
    return server;
  }

  /** 認可を扱えるのは http のサーバーだけ。 */
  function asHttpServer(serverId: string, server: McpServerSettings): McpHttpServerSettings {
    if (server.type !== "http") {
      throw new Error(`MCP サーバー ${serverId} はローカルで動くため、認可は要りません`);
    }
    return server;
  }

  /** いま分かっている状態。認可の待ちを最優先する。 */
  function statusOf(serverId: string): McpServerStatusView {
    if (pending.has(serverId)) return { state: "authorizing", tools: [], detail: null };
    return statuses.get(serverId) ?? { state: "unknown", tools: [], detail: null };
  }

  return {
    status(serverId) {
      return statusOf(serverId);
    },

    async check(serverId) {
      const servers = settings.read().mcpServers;
      if (servers[serverId] === undefined) throw new McpServerNotFound(serverId);
      // 認可を待っている間は繋ぎに行かない。接続を試すと認可の要求が作り直され、
      // ブラウザで開いている URL が使えなくなる。
      if (pending.has(serverId)) return statusOf(serverId);

      // このサーバーだけ繋ぎ直す。他のサーバーの接続はそのまま使う。
      await ensureConnections(servers);
      const existing = connections.get(serverId);
      if (existing !== undefined) {
        connections.delete(serverId);
        await existing.client.close().catch(() => undefined);
      }

      await refresh(servers);
      return statusOf(serverId);
    },

    /**
     * 保存する前に、渡された設定で繋がるか確かめる。設定にも接続の一覧にも何も残さない。
     *
     * 認可を待っている間に同じ設定で呼び直されたら、繋ぎに行かずに待ち状態を返す。
     * 繋ぎに行くと認可の要求が作り直され、ブラウザで開いている URL が使えなくなるため。
     */
    async test(serverId, server) {
      const waiting = pendingTests.get(serverId);
      if (waiting !== undefined) {
        if (sameServer(waiting.server, server)) {
          return { state: "authorizing", tools: [], detail: null, authorizationUrl: waiting.url };
        }
        // 別の接続先を確かめるのだから、待っていた認可は捨てる。
        pendingTests.delete(serverId);
      }

      const material = connectionFor(serverId, server);
      const client = new Client({ name: `terasuma-test-${serverId}`, version: "1.0.0" });

      try {
        await client.connect(material.transport, { timeout: DISCOVERY_TIMEOUT_MS });
        const listed = await client.listTools(undefined, { timeout: DISCOVERY_TIMEOUT_MS });
        return {
          state: "connected",
          tools: listed.tools.map((definition) => definition.name),
          detail: null,
          authorizationUrl: null,
        };
      } catch (error) {
        const authorizationUrl = material.oauth?.takeAuthorizationUrl() ?? null;
        if (authorizationUrl !== null) {
          // コールバックを受けたときに、まだ設定に無い接続先でも終わらせられるように控える。
          pendingTests.set(serverId, { server, url: authorizationUrl });
          return { state: "authorization_required", tools: [], detail: null, authorizationUrl };
        }

        return { state: "failed", tools: [], detail: describeError(error), authorizationUrl: null };
      } finally {
        await client.close().catch(() => undefined);
      }
    },

    async toolset() {
      const servers = settings.read().mcpServers;
      if (Object.keys(servers).length === 0) return {};

      await ensureConnections(servers);
      // 一度も探索していなければ繋ぎに行く。落ちているサーバーをチャットのたびに試さない。
      if (!discovered) await refresh(servers);
      return tools;
    },

    async authorize(serverId) {
      const server = asHttpServer(serverId, requireServer(serverId));

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

      // 保存前の確認で始めた認可は、その候補の接続先で終わらせる（設定にはまだ書かれていない）。
      const candidate = pendingTests.get(serverId)?.server ?? settings.read().mcpServers[serverId];
      if (candidate === undefined) throw new McpServerNotFound(serverId);
      const server = asHttpServer(serverId, candidate);

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
        statuses.set(serverId, { state: "failed", tools: [], detail: describeError(error) });
        throw error;
      } finally {
        // 待つのを止める。次に確かめるときは、新しい状態（トークンがある）で繋ぎに行く。
        pending.delete(serverId);
        pendingTests.delete(serverId);
      }

      return { serverId };
    },

    async close() {
      await closeConnections();
      settingsKey = null;
      statuses = new Map();
      tools = {};
      discovered = false;
    },
  };
}

/** 1 つのサーバーのツールを、モデルへ渡す名前と定義の組にする。 */
function toolEntries(serverId: string, connection: ServerConnection, images: ImageStore): [string, ToolSet[string]][] {
  return connection.tools.map((definition) => [
    toolNameFor(serverId, definition.name),
    tool({
      description: definition.description ?? "",
      inputSchema: jsonSchema(definition.inputSchema as unknown as JSONSchema7),
      execute: async (input: unknown, options: { abortSignal?: AbortSignal }) => {
        const result = await connection.client.callTool(
          { name: definition.name, arguments: asArguments(input) },
          options.abortSignal === undefined ? {} : { signal: options.abortSignal },
        );

        const output = callToolOutput(result, images);
        // エラーは例外にして、モデルへ本文だけを渡す（JSON の包装を見せない）。
        if (result.isError === true) throw new Error(output.text);
        return output;
      },
    }),
  ]);
}

/** ツールの入力は必ずオブジェクト。壊れた形は空として扱い、サーバー側の検証に任せる。 */
function asArguments(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

/**
 * MCP の結果から、モデルへ渡す本文と画像を取り出す。
 * 画像は置き場に保存し、会話とモデルへは参照だけを渡す（base64 を載せない）。
 */
function callToolOutput(result: CallToolResult, images: ImageStore): ImageToolOutput {
  const texts: string[] = [];
  const refs: ImageRef[] = [];

  for (const block of result.content) {
    if (block.type === "text") {
      texts.push(block.text);
      continue;
    }
    if (block.type !== "image") continue;

    try {
      refs.push(images.save(Buffer.from(block.data, "base64"), block.mimeType));
    } catch (error) {
      // 扱えない形式や壊れた中身でも、他の内容は読めるようにする。
      texts.push(`(Could not store the image returned by the tool: ${describeError(error)})`);
    }
  }

  if (texts.length > 0) {
    return { text: texts.join("\n"), ...(refs.length === 0 ? {} : { images: refs }) };
  }

  if (refs.length > 0) {
    return {
      text: refs.length === 1 ? "(image returned by the tool)" : `(${refs.length} images returned by the tool)`,
      images: refs,
    };
  }

  // テキストも画像も無い（資源や音声だけ）場合は、結果全体を JSON として見せる。
  return { text: JSON.stringify(result) };
}

/**
 * 同じ接続先を確かめているかどうか。
 * 設定はどちらも入力から組み立てたものなので、項目の並びまで同じになる。
 */
function sameServer(left: McpServerSettings, right: McpServerSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

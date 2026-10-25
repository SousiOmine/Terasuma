import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import type { ToolSet } from "ai";
import type { McpHttpServerSettings, McpServerSettings, McpServersSettings } from "../data/settings";
import { toolNameFor } from "../../shared/tools";
import { AppError } from "../errors";
import type { McpAuthorizationView, McpServerStatusView, McpTestView } from "../../shared/api/settings";
import {
  createFileOAuthStorage,
  finishMcpAuthorization,
  serverIdFromState,
  startMcpAuthorization,
  type OAuthStorage,
} from "./oauth";
import type { ConnectionMaterial, ServerConnection } from "./connection";
import { connectionMaterial } from "./transport";
import { sameServer, toolEntries } from "./tools";
import type { ImageStore } from "../computer/images";
import type { SettingsStore } from "../data/settings";
import { describeError } from "../../shared/errors";

/** モデルへ渡すツール。キーは "<サーバー id>_<ツール名>"。 */
export type McpToolset = ToolSet;

/** 設定に無い MCP サーバーを触ろうとしたときの失敗。 */
export class McpServerNotFound extends AppError {
  constructor(readonly serverId: string) {
    super("mcp_server_not_found", 404, `MCP サーバー ${serverId} は設定されていません`);
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
  /**
   * 設定から消えたサーバーの接続・認可の待ち・状態・ツールを、その場で片付ける。
   * 設定にまだ残っている id では何もしない（消す順を取り違えたときに、繋がっている接続を落とさないため）。
   */
  forget(serverId: string): Promise<void>;
  /** OAuth の認可を始める。開く URL を返す（すでに認可済みなら null）。 */
  authorize(serverId: string): Promise<McpAuthorizationView>;
  /** 待っている認可を取り消す。次に接続を確かめたときの結果に戻る。 */
  cancelAuthorization(serverId: string): void;
  /**
   * 保存前の確認で待っている認可をやめる。
   * 画面を閉じたときや待ちがタイムアウトしたときに呼ぶ（同じ設定をやり直せるようにする）。
   */
  cancelTest(serverId: string): void;
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

/**
 * 保存前の認可待ちを、これ以上は使い回さない時間。
 * 画面の待ち（5 分）より長く取り、取り残された待ちは次の確認でやり直す。
 */
const TEST_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

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
  /** サーバー id → いま分かっている状態。 */
  let statuses = new Map<string, McpServerStatusView>();
  /** モデルへ渡すツール。 */
  let tools: McpToolset = {};
  /** 一度でも探索したかどうか。落ちているサーバーを毎ターン試しに行かないため。 */
  let discovered = false;
  /** 最後に接続を作ったときの設定（JSON）。変わったサーバーだけ繋ぎ直すための比較用。 */
  let settingsKey: string | null = null;
  /** 認可を待っているサーバー（id → 認可画面の URL）。 */
  const pending = new Map<string, string>();
  /** 保存前の確認で認可を待っているサーバー（id → 確かめている設定と、認可画面の URL）。 */
  const pendingTests = new Map<string, { server: McpServerSettings; url: string; at: number }>();

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
    return connectionMaterial({
      serverId,
      server,
      callbackUrl,
      storage: () => storageFor(serverId),
    });
  }

  /** すべての接続を閉じる。設定が変わったときと、終了するときに使う。 */
  async function closeConnections(): Promise<void> {
    const current = [...connections.values()];
    connections = new Map();
    for (const connection of current) {
      await connection.client.close().catch(() => undefined);
    }
  }

  /** 設定が変わっていれば、変わったサーバーだけ繋ぎ直す（他の接続はそのまま使う）。 */
  async function syncSettings(servers: McpServersSettings): Promise<void> {
    const key = JSON.stringify(servers);
    if (key === settingsKey && discovered) return;

    settingsKey = key;
    await refresh(servers);
  }

  /**
   * すべてのサーバーへ接続してツールを取り直し、状態を置き換える。
   * つながっているサーバーは、設定が変わっていない限り接続を使い回す。
   */
  async function refresh(servers: McpServersSettings): Promise<void> {
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
        // 取り残された待ちは、古くなっていたらやり直す（画面を閉じただけでは消えないため）。
        if (sameServer(waiting.server, server) && Date.now() - waiting.at < TEST_AUTHORIZATION_TTL_MS) {
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
          pendingTests.set(serverId, { server, url: authorizationUrl, at: Date.now() });
          return { state: "authorization_required", tools: [], detail: null, authorizationUrl };
        }

        return { state: "failed", tools: [], detail: describeError(error), authorizationUrl: null };
      } finally {
        await client.close().catch(() => undefined);
      }
    },

    async toolset() {
      const servers = settings.read().mcpServers;
      // 設定が変わっていれば、変わったサーバーだけ繋ぎ直す。
      // 空になったときも通し、refresh() に残りの接続を閉じさせる。
      await syncSettings(servers);
      return tools;
    },

    async forget(serverId) {
      // 設定に残っているなら、消す順を取り違えている。繋がっている接続は落とさない。
      if (settings.read().mcpServers[serverId] !== undefined) return;

      pending.delete(serverId);
      pendingTests.delete(serverId);

      const connection = connections.get(serverId);
      connections.delete(serverId);
      if (connection !== undefined) await connection.client.close().catch(() => undefined);

      statuses.delete(serverId);

      // 次のツール取得を待たず、設定から消えたサーバーのツールを外す。
      // settingsKey は触らない（次の syncSettings が差分を見て他の接続を揃える）。
      rebuild(settings.read().mcpServers);
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

    cancelTest(serverId) {
      pendingTests.delete(serverId);
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

import { join } from "node:path";
import type { AppConfig } from "./config";
import { createCompaction, type Compaction } from "./server/agent/compaction";
import { createEngine, type AgentEngine } from "./server/agent/engine";
import { createSkillFileStore } from "./server/agent/skill-files";
import { createCodingToolset } from "./server/agent/tools/coding";
import { createComputerToolset } from "./server/agent/tools/computer";
import { createAttachmentTools } from "./server/agent/tools/attachments";
import { createHistoryToolset } from "./server/agent/tools/history";
import { createWebSearchToolset } from "./server/agent/tools/web";
import { createWebSearchManager, type WebSearchManager } from "./server/websearch-manager";
import { createContainerManager, type ContainerManager } from "./server/computer/container";
import { WORKDIR_IN_CONTAINER } from "./server/computer/contract";
import { createEnvRequests } from "./server/computer/env";
import { createFileStore } from "./server/computer/files";
import { createHandover } from "./server/computer/handover";
import { createImageStore } from "./server/computer/images";
import { createSettingsStore, type SettingsStore } from "./server/data/settings";
import { createStore, type Store } from "./server/data/store";
import { createConnections, type ConnectionsManager } from "./server/connections/manager";
import { createConnectionToolset } from "./server/connections/tools";
import { createDiscordWebhooks, type DiscordWebhooks } from "./server/discord/manager";
import { createDiscordToolset } from "./server/discord/tools";
import { startServer, type StartedServer } from "./server/http/server";
import { createMcpManager, type McpManager } from "./server/mcp/manager";
import { OAUTH_CALLBACK_PATH } from "./server/mcp/oauth";
import { CATALOG_FILE_NAME, createCatalog, modelContextTokens, type Catalog } from "./server/provider/catalog";
import type { ConnectionChecker, ProviderModelLister } from "./server/provider/connection";
import type { SentAttachment } from "./shared/api/message";

/**
 * 依存を組み立てて、動くアプリを 1 つ作る（合成ルート）。
 *
 * ここだけが「どの実装をどの設定で繋ぐか」を知っている。各モジュールは渡された相手だけを使う。
 * 起動の手順（ログ、停止の受け付け、最初の読み込み）は index.ts が受け持つ。
 *
 * overrides は、本物の組み立てのまま一部だけを差し替える口（live テストのように、
 * メモリ上の DB で本番と同じ配線を確かめるときに使う）。
 */

export type App = {
  config: AppConfig;
  server: StartedServer["server"];
  portChanged: boolean;
  store: Store;
  settings: SettingsStore;
  catalog: Catalog;
  compaction: Compaction;
  mcp: McpManager;
  /** アプリの接続（GitHub など）。設定画面とチャットのカードから使う。 */
  connections: ConnectionsManager;
  /** Discord の webhook（送信先は Tera ごと）。設定画面とチャットのカードから使う。 */
  discord: DiscordWebhooks;
  container: ContainerManager;
  /** Web 検索の設定と接続確認。設定画面からの操作もここを通す。 */
  webSearch: WebSearchManager;
  /** 接続・予約・DB を畳んでから終わる。 */
  shutdown(): Promise<void>;
};

/** 本物の組み立てのまま、一部だけを差し替える口。 */
export type AppOverrides = {
  store?: Store;
  engine?: AgentEngine;
  container?: ContainerManager;
  mcp?: McpManager;
  connections?: ConnectionsManager;
  discord?: DiscordWebhooks;
  webSearch?: WebSearchManager;
  catalog?: Catalog;
  checkConnection?: ConnectionChecker;
  listModels?: ProviderModelLister;
};

export function startApp(config: AppConfig, overrides: AppOverrides = {}): App {
  const store = overrides.store ?? createStore(config.dbPath);
  const settings = createSettingsStore(config.configPath);

  // ツールが返した画像は、データディレクトリにファイルとして置く（会話には参照だけが残る）。
  // MCP の接続もこの置き場へ画像を保存するので、接続より先に用意する。
  const images = createImageStore(config.dataDir);
  // エージェントがユーザーへ送る、画像以外のファイルの置き場。
  const files = createFileStore(config.dataDir);

  // エージェントが作ったスキルは、コンピュータのホームの .agents/skills に置く。
  const skills = createSkillFileStore({ dataDir: config.dataDir });

  // アプリの接続。トークンはデータディレクトリに置き、コンピュータの環境変数にも混ぜる。
  // 接続が設定した値は、設定ファイルの env より優先する（接続し直した結果を使うため）。
  const connections = overrides.connections ?? createConnections({ dataDir: config.dataDir });

  // Discord の送信先（webhook URL）は Tera ごとに持つ。URL は秘密なのでデータディレクトリへ 0600 で置く。
  const discord = overrides.discord ?? createDiscordWebhooks({ store, dataDir: config.dataDir });

  // 認可コードの受け取り先は、待ち受けているポートが決まってから決まる。
  // 実際に使うポートは startServer の戻り値で分かるので、そこまで null のままにする。
  let boundPort: number | null = null;
  const mcp =
    overrides.mcp ??
    createMcpManager({
      settings,
      dataDir: config.dataDir,
      images,
      callbackUrl: () =>
        boundPort === null ? null : new URL(`http://${config.host}:${boundPort}${OAUTH_CALLBACK_PATH}`),
    });

  // デスクトップ用の Containerfile と entry.sh は、リポジトリの container/ に置いてある。
  // src から実行しても dist から実行しても、1 つ上がリポジトリのルートになる。
  // エージェントがチャットで受け取った環境変数は、コンテナの中のコマンドへ渡す。
  const container =
    overrides.container ??
    createContainerManager({
      dataDir: config.dataDir,
      containerDir: join(import.meta.dir, "..", "container"),
      env: () => ({ ...settings.read().env, ...connections.env() }),
    });

  // エージェントがユーザーへ画面を渡すときの待ち（ログインや二段階認証）。
  const handover = createHandover();
  // エージェントが秘密（API キーなど）を必要としたときの、チャットからの入力待ち。
  // 値はここで設定へ書き、ツールの戻り値（モデルの文脈）には含めない。
  const envRequests = createEnvRequests({ settings });
  const computer = createComputerToolset({ container, images, handover, env: envRequests });

  // コンテナのファイルとシェルを扱うツール（read / write / edit / bash）。
  // いずれもコンピュータのコンテナの中だけで動き、ホストのファイルには触れない。
  const coding = createCodingToolset({ container, root: WORKDIR_IN_CONTAINER });

  // 画像やファイルをチャットへ添付するツール（chat_attach）。添付の口はターンごとに渡す。
  const attachments = {
    toolset: (input: { attach: (attachments: SentAttachment[]) => void }) =>
      createAttachmentTools({ container, root: WORKDIR_IN_CONTAINER, images, files, attach: input.attach }),
  };

  // 過去の対話履歴を検索するツール（history_search）。引く履歴はターンごとに渡す。
  const history = createHistoryToolset({ store });

  // Web 検索とページ取得（web_search / web_fetch）。使うプロバイダは設定の既定で決まる。
  const webSearchManager = overrides.webSearch ?? createWebSearchManager({ settings });
  const webSearch = createWebSearchToolset({ manager: webSearchManager });

  // 畳むかどうかは、モデルの文脈長（カタログ）から決める。
  // 起動後にカタログを読んでおくので、設定画面を開かなくても文脈長が分かる。
  // エンジンも、プロバイダの呼び出し方を決めるのにカタログを使う。
  const catalog = overrides.catalog ?? createCatalog({ cachePath: join(config.dataDir, CATALOG_FILE_NAME) });
  const engine =
    overrides.engine ??
    createEngine({
      config,
      settings,
      mcp,
      computer,
      attachments,
      history,
      webSearch,
      connections: createConnectionToolset(connections),
      discord: createDiscordToolset({ discord }),
      coding,
      images,
      catalog,
      skills,
      identity: store,
    });

  // 古いやり取りは、3 時間の放置か、文脈長に近づいたときに、背景で要約へ畳む。
  // 失敗は端末に出す（会話は生の履歴のまま続く）。
  const compaction = createCompaction({
    store,
    engine,
    log: (message) => console.log(message),
    contextLimit: () => modelContextTokens(catalog.snapshot(), settings.read().model),
  });

  const { server, portChanged } = startServer({
    config,
    store,
    engine,
    compaction,
    catalog,
    settings,
    mcp,
    connections,
    discord,
    webSearch: webSearchManager,
    container,
    images,
    files,
    handover,
    envRequests,
    ...(overrides.checkConnection === undefined ? {} : { checkConnection: overrides.checkConnection }),
    ...(overrides.listModels === undefined ? {} : { listModels: overrides.listModels }),
  });
  boundPort = server.port ?? null;

  return {
    config,
    server,
    portChanged,
    store,
    settings,
    catalog,
    compaction,
    mcp,
    connections,
    discord,
    container,
    webSearch: webSearchManager,

    async shutdown() {
      // 畳まないと、MCP サーバーの接続と SQLite の WAL、圧縮の予約がそのまま残る。
      await server.stop(true);
      connections.close();
      discord.close();
      await mcp.close();
      compaction.close();
      store.close();
    },
  };
}

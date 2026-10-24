import { join } from "node:path";
import type { AppConfig } from "./config";
import type { AttachmentToolsetProvider, CodingToolsetProvider } from "./server/agent/contracts";
import { createCompaction, type Compaction } from "./server/agent/compaction";
import { createEngine, type AgentEngine } from "./server/agent/engine";
import { createSkillFileStore } from "./server/agent/skill-files";
import { PI_CODING_SKILL } from "./server/agent/skills";
import { createCodingToolset } from "./server/agent/tools/coding";
import { createComputerToolset } from "./server/agent/tools/computer";
import { createAttachmentTools } from "./server/agent/tools/attachments";
import { createHistoryToolset } from "./server/agent/tools/history";
import { createTeraToolset } from "./server/agent/tools/tera";
import { createWebSearchToolset } from "./server/agent/tools/web";
import { createWebSearchManager, type WebSearchManager } from "./server/websearch-manager";
import { ContainerError, createContainerManager, type ContainerManager } from "./server/computer/container";
import { createEnvRequests } from "./server/computer/env";
import { createFileStore } from "./server/computer/files";
import { createHandover } from "./server/computer/handover";
import { createImageStore } from "./server/computer/images";
import { ensureTeraWorkspace } from "./server/computer/workspaces";
import { createSettingsStore, type SettingsStore } from "./server/data/settings";
import { createStore, type Store } from "./server/data/store";
import { createConnectors, type ConnectorsManager } from "./server/connectors/manager";
import { createConnectorToolset } from "./server/connectors/tools";
import { createDiscordWebhooks, type DiscordWebhooks } from "./server/discord/manager";
import { createDiscordToolset } from "./server/discord/tools";
import { startServer, type StartedServer } from "./server/http/server";
import { createMcpManager, type McpManager } from "./server/mcp/manager";
import { OAUTH_CALLBACK_PATH } from "./server/mcp/oauth";
import { CATALOG_FILE_NAME, createCatalog, modelContextTokens, type Catalog } from "./server/provider/catalog";
import type { ConnectionChecker, ProviderModelLister } from "./server/provider/connection";

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
  /** コネクタ（GitHub など）。設定画面とチャットのカードから使う。 */
  connectors: ConnectorsManager;
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
  connectors?: ConnectorsManager;
  discord?: DiscordWebhooks;
  webSearch?: WebSearchManager;
  catalog?: Catalog;
  checkConnection?: ConnectionChecker;
  listModels?: ProviderModelLister;
};

export function startApp(config: AppConfig, overrides: AppOverrides = {}): App {
  const store = overrides.store ?? createStore(config.dbPath);
  const settings = createSettingsStore(config.configPath);

  // Tera ごとの作業フォルダは、コンテナのホームの中に置く（/home/agent/teras/<tera id>）。
  // 起動時に既知の Tera の分を作っておく（作成時とターンの開始時にも作るので、リセットで消えても戻る）。
  for (const tera of store.listTeras()) ensureTeraWorkspace(config.dataDir, tera.id);

  // ツールが返した画像は、データディレクトリにファイルとして置く（会話には参照だけが残る）。
  // MCP の接続もこの置き場へ画像を保存するので、接続より先に用意する。
  const images = createImageStore(config.dataDir);
  // エージェントがユーザーへ送る、画像以外のファイルの置き場。
  const files = createFileStore(config.dataDir);

  // エージェントが作ったスキルは、コンピュータのホームの .agents/skills に置く。
  const skills = createSkillFileStore({ dataDir: config.dataDir });

  // コネクタ。トークンはデータディレクトリに置き、コンピュータの環境変数にも混ぜる。
  // コネクタが設定した値は、設定ファイルの env より優先する（接続し直した結果を使うため）。
  // program コネクタ（pi）はコンテナの中で確かめるので、コンテナは後で作ってここに入れる。
  let containerRef: ContainerManager | null = null;
  const connectors =
    overrides.connectors ??
    createConnectors({
      dataDir: config.dataDir,
      runtime: {
        async run(script, { timeoutMs }) {
          if (containerRef === null) throw new Error("The computer is not ready yet.");
          return containerRef.shell(script, { timeoutMs });
        },
        async readText(path) {
          if (containerRef === null) throw new Error("The computer is not ready yet.");
          try {
            return Buffer.from(await containerRef.readFile(path)).toString("utf8");
          } catch (error) {
            // 無いファイルは「まだ設定が無い」として扱う（コンテナが止まっているのは別）。
            if (error instanceof ContainerError) throw error;
            return null;
          }
        },
        async writeText(path, text) {
          if (containerRef === null) throw new Error("The computer is not ready yet.");
          await containerRef.writeFile(path, Buffer.from(text, "utf8"));
        },
      },
    });

  // 接続している間だけ一覧に載せるスキル（pi-coding）があるか。
  // テストで差し替えたコネクタの一覧に無い id を、ターンのたびに触らないようにする。
  const hasPiConnector = connectors.ids().includes("pi");

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
      env: () => ({ ...settings.read().env, ...connectors.env() }),
    });
  containerRef = container;

  // エージェントがユーザーへ画面を渡すときの待ち（ログインや二段階認証）。
  const handover = createHandover();
  // エージェントが秘密（API キーなど）を必要としたときの、チャットからの入力待ち。
  // 値はここで設定へ書き、ツールの戻り値（モデルの文脈）には含めない。
  const envRequests = createEnvRequests({ settings });
  const computer = createComputerToolset({ container, images, handover, env: envRequests });

  // コンテナのファイルとシェルを扱うツール（read / write / edit / bash）。
  // いずれもコンピュータのコンテナの中だけで動き、ホストのファイルには触れない。
  // 相対パスと bash の cwd は Tera ごとの作業フォルダになるので、ターンごとに組む。
  const coding: CodingToolsetProvider = {
    toolset: ({ teraId }) => createCodingToolset({ container, root: ensureTeraWorkspace(config.dataDir, teraId) }),
  };

  // 画像やファイルをチャットへ添付するツール（chat_attach）。
  // 添付の口はターンごとに変わり、相対パスはその Tera の作業フォルダを基準にする。
  const attachments: AttachmentToolsetProvider = {
    toolset: ({ teraId, attach }) =>
      createAttachmentTools({
        container,
        root: ensureTeraWorkspace(config.dataDir, teraId),
        images,
        files,
        attach,
      }),
  };

  // 過去の対話履歴を検索するツール（history_search）。引く履歴はターンごとに渡す。
  const history = createHistoryToolset({ store });

  // 新しい Tera を作るツール（tera_create）。作業フォルダは、Tera ごとの作業場と同じ親に作る。
  const teraToolset = createTeraToolset({ store, dataDir: config.dataDir });

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
      connectors: createConnectorToolset(connectors),
      discord: createDiscordToolset({ discord }),
      tera: teraToolset,
      coding,
      images,
      catalog,
      skills,
      identity: store,
      extraSkills: () => (hasPiConnector && connectors.connected("pi") ? [PI_CODING_SKILL] : []),
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
    connectors,
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
    connectors,
    discord,
    container,
    webSearch: webSearchManager,

    async shutdown() {
      // 畳まないと、MCP サーバーの接続と SQLite の WAL、圧縮の予約がそのまま残る。
      await server.stop(true);
      connectors.close();
      discord.close();
      await mcp.close();
      compaction.close();
      store.close();
    },
  };
}

import { join } from "node:path";
import type { AppConfig } from "./config";
import { createCompaction, type Compaction } from "./server/agent/compaction";
import { createEngine } from "./server/agent/engine";
import { createCodingToolset } from "./server/agent/tools/coding";
import { createComputerToolset } from "./server/agent/tools/computer";
import { createAttachmentTools } from "./server/agent/tools/attachments";
import { createHistoryToolset } from "./server/agent/tools/history";
import { createWebSearchToolset } from "./server/agent/tools/web";
import { createWebSearchManager, type WebSearchManager } from "./server/websearch-manager";
import { createContainerManager, WORKDIR_IN_CONTAINER, type ContainerManager } from "./server/computer/container";
import { createEnvRequests } from "./server/computer/env";
import { createFileStore } from "./server/computer/files";
import { createHandover } from "./server/computer/handover";
import { createImageStore } from "./server/computer/images";
import { createSettingsStore, type SettingsStore } from "./server/data/settings";
import { createStore, type Store } from "./server/data/store";
import { startServer, type StartedServer } from "./server/http/server";
import { createMcpManager, type McpManager } from "./server/mcp/manager";
import { OAUTH_CALLBACK_PATH } from "./server/mcp/oauth";
import { CATALOG_FILE_NAME, createCatalog, modelContextTokens, type Catalog } from "./server/provider/catalog";
import type { SentAttachment } from "./shared/types";

/**
 * 依存を組み立てて、動くアプリを 1 つ作る（合成ルート）。
 *
 * ここだけが「どの実装をどの設定で繋ぐか」を知っている。各モジュールは渡された相手だけを使う。
 * 起動の手順（ログ、停止の受け付け、最初の読み込み）は index.ts が受け持つ。
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
  container: ContainerManager;
  /** Web 検索の設定と接続確認。設定画面からの操作もここを通す。 */
  webSearch: WebSearchManager;
  /** 接続・予約・DB を畳んでから終わる。 */
  shutdown(): Promise<void>;
};

export function startApp(config: AppConfig): App {
  const store = createStore(config.dbPath);
  const settings = createSettingsStore(config.configPath);

  // ツールが返した画像は、データディレクトリにファイルとして置く（会話には参照だけが残る）。
  // MCP の接続もこの置き場へ画像を保存するので、接続より先に用意する。
  const images = createImageStore(config.dataDir);
  // エージェントがユーザーへ送る、画像以外のファイルの置き場。
  const files = createFileStore(config.dataDir);

  // 認可コードの受け取り先は、待ち受けているポートが決まってから決まる。
  // 実際に使うポートは startServer の戻り値で分かるので、そこまで null のままにする。
  let boundPort: number | null = null;
  const mcp = createMcpManager({
    settings,
    dataDir: config.dataDir,
    images,
    callbackUrl: () =>
      boundPort === null ? null : new URL(`http://${config.host}:${boundPort}${OAUTH_CALLBACK_PATH}`),
  });

  // デスクトップ用の Containerfile と entry.sh は、リポジトリの container/ に置いてある。
  // src から実行しても dist から実行しても、1 つ上がリポジトリのルートになる。
  // エージェントがチャットで受け取った環境変数は、コンテナの中のコマンドへ渡す。
  const container = createContainerManager({
    dataDir: config.dataDir,
    containerDir: join(import.meta.dir, "..", "container"),
    env: () => settings.read().env,
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
  const webSearchManager = createWebSearchManager({ settings });
  const webSearch = createWebSearchToolset({ manager: webSearchManager });

  // 畳むかどうかは、モデルの文脈長（カタログ）から決める。
  // 起動後にカタログを読んでおくので、設定画面を開かなくても文脈長が分かる。
  // エンジンも、プロバイダの呼び出し方を決めるのにカタログを使う。
  const catalog = createCatalog({ cachePath: join(config.dataDir, CATALOG_FILE_NAME) });
  const engine = createEngine({
    config,
    settings,
    mcp,
    computer,
    attachments,
    history,
    webSearch,
    coding,
    images,
    catalog,
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
    webSearch: webSearchManager,
    container,
    images,
    files,
    handover,
    envRequests,
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
    container,
    webSearch: webSearchManager,

    async shutdown() {
      // 畳まないと、MCP サーバーの接続と SQLite の WAL、圧縮の予約がそのまま残る。
      await server.stop(true);
      await mcp.close();
      compaction.close();
      store.close();
    },
  };
}

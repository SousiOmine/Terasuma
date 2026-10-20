import { join } from "node:path";
import type { AppConfig } from "./config";
import { createCompaction, type Compaction } from "./server/agent/compaction";
import { createEngine } from "./server/agent/engine";
import { createCodingToolset } from "./server/agent/tools/coding";
import { createComputerToolset } from "./server/agent/tools/computer";
import { createContainerManager, WORKDIR_IN_CONTAINER, type ContainerManager } from "./server/computer/container";
import { createHandover } from "./server/computer/handover";
import { createImageStore } from "./server/computer/images";
import { createSettingsStore, type SettingsStore } from "./server/data/settings";
import { createStore, type Store } from "./server/data/store";
import { startServer, type StartedServer } from "./server/http/server";
import { createMcpManager, type McpManager } from "./server/mcp/manager";
import { OAUTH_CALLBACK_PATH } from "./server/mcp/oauth";
import { CATALOG_FILE_NAME, createCatalog, modelContextTokens, type Catalog } from "./server/provider/catalog";

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
  /** 接続・予約・DB を畳んでから終わる。 */
  shutdown(): Promise<void>;
};

export function startApp(config: AppConfig): App {
  const store = createStore(config.dbPath);
  const settings = createSettingsStore(config.configPath);

  // ツールが返した画像は、データディレクトリにファイルとして置く（会話には参照だけが残る）。
  // MCP の接続もこの置き場へ画像を保存するので、接続より先に用意する。
  const images = createImageStore(config.dataDir);

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
  const container = createContainerManager({
    dataDir: config.dataDir,
    containerDir: join(import.meta.dir, "..", "container"),
  });

  // エージェントがユーザーへ画面を渡すときの待ち（ログインや二段階認証）。
  const handover = createHandover();
  const computer = createComputerToolset({ container, images, handover });

  // コンテナのファイルとシェルを扱うツール（read / write / edit / bash）。
  // いずれもコンピュータのコンテナの中だけで動き、ホストのファイルには触れない。
  const coding = createCodingToolset({ container, root: WORKDIR_IN_CONTAINER });

  // 畳むかどうかは、モデルの文脈長（カタログ）から決める。
  // 起動後にカタログを読んでおくので、設定画面を開かなくても文脈長が分かる。
  // エンジンも、プロバイダの呼び出し方を決めるのにカタログを使う。
  const catalog = createCatalog({ cachePath: join(config.dataDir, CATALOG_FILE_NAME) });
  const engine = createEngine({ config, settings, mcp, computer, coding, images, catalog });

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
    container,
    handover,
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

    async shutdown() {
      // 畳まないと、MCP サーバーの接続と SQLite の WAL、圧縮の予約がそのまま残る。
      await server.stop(true);
      await mcp.close();
      compaction.close();
      store.close();
    },
  };
}

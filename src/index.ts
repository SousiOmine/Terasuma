import { join } from "node:path";
import { ensureDirectories, loadConfig } from "./config";
import { createCodingToolset } from "./server/coding";
import { createCompaction } from "./server/compaction";
import { createComputerToolset } from "./server/computer";
import { createContainerManager, WORKDIR_IN_CONTAINER } from "./server/container";
import { createEngine, resolveModel } from "./server/engine";
import { describeError } from "./shared/errors";
import { createHandover } from "./server/handover";
import { createImageStore } from "./server/images";
import { createMcpManager } from "./server/mcp";
import { OAUTH_CALLBACK_PATH } from "./server/mcp-oauth";
import { CATALOG_FILE_NAME, createCatalog, modelContextTokens } from "./server/models-dev";
import { startServer } from "./server/server";
import { createSettingsStore } from "./server/settings";
import { createStore } from "./server/store";

const config = loadConfig();
ensureDirectories(config);

const store = createStore(config.dbPath);
const settings = createSettingsStore(config.configPath);

// 認可コードの受け取り先は、待ち受けているポートが決まってから決まる。
// 実際に使うポートは startServer の戻り値で分かるので、そこまで null のままにする。
let boundPort: number | null = null;
const mcp = createMcpManager({
  settings,
  dataDir: config.dataDir,
  callbackUrl: () =>
    boundPort === null ? null : new URL(`http://${config.host}:${boundPort}${OAUTH_CALLBACK_PATH}`),
});

// Containerfile と entry.sh は、リポジトリの container/ に置いてある。
// src から実行しても dist から実行しても、1 つ上がリポジトリのルートになる。
const container = createContainerManager({
  dataDir: config.dataDir,
  containerDir: join(import.meta.dir, "..", "container"),
});

// ツールが撮った画像は、データディレクトリにファイルとして置く（会話には参照だけが残る）。
const images = createImageStore(config.dataDir);

// エージェントがユーザーへ画面を渡すときの待ち（ログインや二段階認証）。
const handover = createHandover();

const computer = createComputerToolset({ container, images, handover });

// コンテナのファイルとシェルを扱うツール（read / write / edit / bash）。
// いずれもコンピュータのコンテナの中だけで動き、ホストのファイルには触れない。
const coding = createCodingToolset({ container, root: WORKDIR_IN_CONTAINER });

const engine = createEngine({ config, settings, mcp, computer, coding, images });

// 畳むかどうかは、モデルの文脈長（カタログ）から決める。
// 起動後にカタログを読んでおくので、設定画面を開かなくても文脈長が分かる。
const catalog = createCatalog({ cachePath: join(config.dataDir, CATALOG_FILE_NAME) });

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

// モデルが未設定でも起動はする（画面から追加できる）。気づけるようにここで 1 行だけ出す。
const model = settings.read().model;
const resolution = resolveModel(settings.read());

console.log(
  [
    `Terasuma  http://${server.hostname}:${server.port}`,
    `  engine : ${engine.name}`,
    `  model  : ${model ?? "(未設定)"}`,
    // 設定と違うポートで起動したことは黙らない。開く先が表示と食い違ってしまうため。
    ...(portChanged ? [`  note   : ${config.port} は使用中だったので、空いているポートを使います`] : []),
    ...(resolution.ok ? [] : [`  note   : ${resolution.detail}`]),
    `  config : ${config.configPath}`,
    `  data   : ${config.dataDir}`,
  ].join("\n"),
);

// 端末からの停止（Ctrl+C）や OS からの停止で、接続と DB を畳んでから終わる。
// 畳まないと、MCP サーバーの接続と SQLite の WAL がそのまま残る。
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`\n  ${signal} を受けたので終わります`);

  try {
    await server.stop(true);
    await mcp.close();
    store.close();
  } catch (error) {
    console.log(`  終われませんでした: ${describeError(error)}`);
  }
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

// 設定画面を開かなくてもモデルの文脈長が分かるよう、起動後にカタログを読んでおく。
// 取れなくても起動は止めない（圧縮は既定の見積もりで動き、画面は必要になったときに取りに行く）。
void catalog.load().catch((error: unknown) => {
  console.log(`  catalog: 読めませんでした — ${describeError(error)}`);
});

// 最後のやり取りから 3 時間以上たっている（か、文脈長に近づいている）Tera は、
// ここで要約を作り始める。ターンは待たないので、話し始めても遅くならない。
for (const tera of store.listTeras()) compaction.check(tera.id);

// ホストを再起動したあとも同じ画面に戻れるよう、起動時にコンテナも起こし直す。
// 初回はイメージの build で数分かかるので、待たずに進め、結果だけを知らせる。
void container
  .start()
  .then((status) => {
    const where = status.vncPort === null ? "" : ` (vnc 127.0.0.1:${status.vncPort})`;
    console.log(`  container: ${status.state}${where}${status.detail === null ? "" : ` — ${status.detail}`}`);
  })
  .catch((error: unknown) => {
    console.log(`  container: 起動できませんでした — ${describeError(error)}`);
  });

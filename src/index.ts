import { ensureDirectories, loadConfig } from "./config";
import { createEngine, resolveModel } from "./server/engine";
import { createMcpManager } from "./server/mcp";
import { OAUTH_CALLBACK_PATH } from "./server/mcp-oauth";
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

const engine = createEngine({ config, settings, mcp });
const { server, portChanged } = startServer({ config, store, engine, settings, mcp });
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

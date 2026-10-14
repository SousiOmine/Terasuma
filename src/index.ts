import { ensureDirectories, loadConfig } from "./config";
import { createEngine, resolveModel } from "./server/engine";
import { createServer } from "./server/server";
import { createSettingsStore } from "./server/settings";
import { createStore } from "./server/store";

const config = loadConfig();
ensureDirectories(config);

const store = createStore(config.dbPath);
const settings = createSettingsStore(config.configPath);
const engine = createEngine({ config, settings });
const server = createServer({ config, store, engine, settings });

// モデルが未設定でも起動はする（画面から追加できる）。気づけるようにここで 1 行だけ出す。
const model = settings.read().model;
const resolution = resolveModel(settings.read());

console.log(
  [
    `Terasuma  http://${server.hostname}:${server.port}`,
    `  engine : ${engine.name}`,
    `  model  : ${model ?? "(未設定)"}`,
    ...(resolution.ok ? [] : [`  note   : ${resolution.detail}`]),
    `  config : ${config.configPath}`,
    `  data   : ${config.dataDir}`,
  ].join("\n"),
);

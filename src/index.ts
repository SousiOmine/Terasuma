import { ensureDataDir, loadConfig } from "./config";
import { createEngine } from "./server/engine";
import { createServer } from "./server/server";
import { createStore } from "./server/store";

const config = loadConfig();
ensureDataDir(config);

const store = createStore(config.dbPath);
const engine = createEngine(config);
const server = createServer({ config, store, engine });

console.log(
  [
    `Terasuma  http://${server.hostname}:${server.port}`,
    `  engine : ${engine.name}`,
    `  model  : ${config.model}`,
    `  data   : ${config.dataDir}`,
  ].join("\n"),
);

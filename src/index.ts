import { startApp } from "./app";
import { ensureDirectories, loadConfig } from "./config";
import { resolveModel } from "./server/provider/routing";
import { describeError } from "./shared/errors";

/**
 * 起動と停止。依存の組み立ては app.ts が持つ。
 */

const config = loadConfig();
ensureDirectories(config);
const app = startApp(config);

// モデルが未設定でも起動はする（画面から追加できる）。気づけるようにここで 1 行だけ出す。
const model = app.settings.read().model;

console.log(
  [
    `Terasuma  http://${app.server.hostname}:${app.server.port}`,
    `  engine : ${app.config.engine}`,
    `  model  : ${model ?? "(未設定)"}`,
    // 設定と違うポートで起動したことは黙らない。開く先が表示と食い違ってしまうため。
    ...(app.portChanged ? [`  note   : ${app.config.port} は使用中だったので、空いているポートを使います`] : []),
    `  config : ${app.config.configPath}`,
    `  data   : ${app.config.dataDir}`,
  ].join("\n"),
);

// 設定画面を開かなくてもモデルの文脈長が分かるよう、起動後にカタログを読んでおく。
// 取れなくても起動は止めない（圧縮は既定の見積もりで動き、画面は必要になったときに取りに行く）。
void app.catalog
  .load()
  .catch((error: unknown) => {
    console.log(`  catalog: 読めませんでした — ${describeError(error)}`);
  })
  .finally(() => {
    // カタログが読めたところで、既定のモデルを呼べるかを確かめる。
    // 起動直後はカタログがまだ無いので、ここで確かめる（誤った注記を出さないため）。
    const resolution = resolveModel(app.settings.read(), app.catalog.snapshot());
    if (!resolution.ok) console.log(`  note   : ${resolution.detail}`);
  });

// 最後のやり取りから 3 時間以上たっている（か、文脈長に近づいている）Tera は、
// ここで要約を作り始める。ターンは待たないので、話し始めても遅くならない。
for (const tera of app.store.listTeras()) app.compaction.check(tera.id);

// ホストを再起動したあとも同じ画面に戻れるよう、起動時にコンテナも起こし直す。
// 初回はイメージの build で数分かかるので、待たずに進め、結果だけを知らせる。
void app.container
  .start()
  .then((status) => {
    const where = status.vncPort === null ? "" : ` (vnc 127.0.0.1:${status.vncPort})`;
    console.log(`  container: ${status.state}${where}${status.detail === null ? "" : ` — ${status.detail}`}`);
  })
  .catch((error: unknown) => {
    console.log(`  container: 起動できませんでした — ${describeError(error)}`);
  });

// 端末からの停止（Ctrl+C）や OS からの停止で、接続と DB を畳んでから終わる。
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`\n  ${signal} を受けたので終わります`);

  try {
    await app.shutdown();
  } catch (error) {
    console.log(`  終われませんでした: ${describeError(error)}`);
  }
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

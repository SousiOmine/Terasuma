import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FILE_NAME, type AppConfig } from "../src/config";
import { CLIENT_HEADER } from "../src/shared/api/events";
import { readSettingsFile, type FileSettings } from "../src/server/data/settings";
import type { ContainerManager } from "../src/server/computer/container";
import { createMockEngine } from "../src/server/agent/engine/mock";
import type { AgentEngine } from "../src/server/agent/engine";
import { createFileStore, type FileStore } from "../src/server/computer/files";
import { createEnvRequests, type EnvRequests } from "../src/server/computer/env";
import { createHandover, type Handover } from "../src/server/computer/handover";
import { createImageStore, type ImageStore } from "../src/server/computer/images";
import { createConversationBroadcast } from "../src/server/conversation/broadcast";
import { createTurns } from "../src/server/conversation/turns";
import type { McpManager } from "../src/server/mcp/manager";
import type { WebSearchManager } from "../src/server/websearch/manager";
import type { RoutineScheduler } from "../src/server/routine/scheduler";
import { CATALOG_FILE_NAME, createCatalog, type Catalog } from "../src/server/provider/catalog";
import {
  createConnectionChecker,
  createModelLister,
  type ConnectionChecker,
  type ProviderModelLister,
} from "../src/server/provider/connection";
import { startServer, type StartedServer } from "../src/server/http/server";
import { createSettingsStore, type SettingsStore } from "../src/server/data/settings";
import { createStore, type Store } from "../src/server/data/store";
import { createConnectors, type ConnectorsManager } from "../src/server/connectors/manager";
import { createDiscordWebhooks, type DiscordWebhooks } from "../src/server/discord/manager";
import {
  TEST_SETTINGS,
  createCompactionStub,
  createContainerStub,
  createMcpStub,
  createRoutineSchedulerStub,
  createWebSearchStub,
} from "./support";

/**
 * HTTP 越しに確かめるテストの土台。
 *
 * 「一時ディレクトリに本物の config.json を置き、ポートは OS に選ばせ、
 * 差し替えたい依存だけを渡してサーバを起こし、終わったら必ず畳む」という形は
 * どの API のテストでも同じになる。この形をここに 1 つだけ置く。
 *
 * 個々のテストファイルは、その API に固有の差し替え（カタログ、候補の一覧、
 * コンテナの状態）だけを渡す。
 */

export type ServerHarnessOptions = {
  /** 起動に使うポート。省くと OS に選ばせる。 */
  port?: number;
  /** 開発モードとして起動するか。ポートが埋まっていたときの振る舞いが変わる。 */
  isDevelopment?: boolean;
  /** 設定ファイルの初期内容。null を渡すとファイルを作らない。 */
  settings?: FileSettings | null;
  /** 設定ファイルの置き場。dir を基に決める（入れ子のディレクトリを作れるようにする）。 */
  configPath?: (dir: string) => string;
  /** 会話のストア。省くとメモリ上の本物を作る。 */
  store?: Store;
  /** モデル呼び出し。省くと待ち時間ゼロのモックを使う。 */
  engine?: AgentEngine;
  /** コンテナ。dir を受け取る関数を渡すと、その中に置き場を作れる。 */
  container?: ContainerManager | ((dir: string) => ContainerManager);
  /** MCP 接続。省くと「何も確かめていない」差し替えを使う。 */
  mcp?: McpManager;
  /** コネクタ。省くと本物を作る（宛先は本物の GitHub のまま）。 */
  connectors?: ConnectorsManager | ((context: { settings: SettingsStore; dir: string }) => ConnectorsManager);
  /** Discord の webhook。省くと本物を作る（通信は本物の fetch のまま）。 */
  discord?: DiscordWebhooks | ((context: { store: Store; dir: string }) => DiscordWebhooks);
  /** Web 検索。省くと「プロバイダ未設定」の差し替えを使う。 */
  webSearch?: WebSearchManager;
  /** ルーチンのスケジューラ。省くと、走らせずに呼び出しだけ記録する差し替えを使う。 */
  routines?: RoutineScheduler;
  /** 引き受け。省くと本物を作る。 */
  handover?: Handover;
  /** 環境変数の入力待ち。省くと本物を作る。 */
  envRequests?: EnvRequests;
  /** models.dev のカタログ。省くとサーバが本物を作る（通信はしない）。 */
  catalog?: Catalog;
  /** プロバイダへの接続確認。 */
  checkConnection?: ConnectionChecker;
  /** 独自エンドポイントのモデル一覧。 */
  listModels?: ProviderModelLister;
};

/** 1 つのサーバと、そのテストが触るものをまとめたもの。 */
export type ServerHarness = {
  server: StartedServer["server"];
  /** 希望のポートが埋まっていて、別のポートで起動したかどうか。 */
  portChanged: boolean;
  url: string;
  /** このテスト専用の一時ディレクトリ。 */
  dir: string;
  store: Store;
  settings: SettingsStore;
  settingsPath: string;
  /** Discord の webhook（Tera ごとの保存先）。テストから状態を確かめるときに使う。 */
  discord: DiscordWebhooks;
  /** ルーチンのスケジューラ（テストから実行の開始や停止を確かめるときに使う）。 */
  routines: RoutineScheduler;
  /** エージェントが送った画像の置き場（配信のテストで使う）。 */
  images: ImageStore;
  /** エージェントが送ったファイルの置き場（配信のテストで使う）。 */
  files: FileStore;
  handover: Handover;
  envRequests: EnvRequests;
  request(path: string, init?: RequestInit): Promise<Response>;
  /** 設定ファイルのいまの中身（書き戻されたかを確かめる）。 */
  file(): FileSettings;
};

/** 差し替えを渡してサーバを起こし、確かめ終わったら畳む。 */
export async function withServer<T>(
  run: (harness: ServerHarness) => Promise<T>,
  options: ServerHarnessOptions = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-test-"));
  const settingsPath = options.configPath?.(dir) ?? join(dir, CONFIG_FILE_NAME);

  if (options.settings !== null) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(options.settings ?? TEST_SETTINGS, null, 2)}\n`, "utf8");
  }

  const settings = createSettingsStore(settingsPath);
  const store = options.store ?? createStore(":memory:");
  const engine = options.engine ?? fastMock();
  const compaction = createCompactionStub(store);
  const handover = options.handover ?? createHandover();
  const envRequests = options.envRequests ?? createEnvRequests({ settings });
  const images = createImageStore(dir);
  const files = createFileStore(dir);
  const container =
    typeof options.container === "function" ? options.container(dir) : (options.container ?? createContainerStub());
  const connectors =
    typeof options.connectors === "function"
      ? options.connectors({ settings, dir })
      : (options.connectors ?? createConnectors({ dataDir: dir }));

  const routines = options.routines ?? createRoutineSchedulerStub();

  const discord =
    typeof options.discord === "function"
      ? options.discord({ store, dir })
      : (options.discord ?? createDiscordWebhooks({ store, dataDir: dir }));

  const config: AppConfig = {
    host: "127.0.0.1",
    port: options.port ?? 0,
    configDir: dir,
    configPath: settingsPath,
    dataDir: dir,
    dbPath: ":memory:",
    engine: "mock",
    isDevelopment: options.isDevelopment ?? false,
  };

  // 走っているターンを止めるため、ハーネスの後始末からも触れるようにしておく。
  const turns = createTurns({ store, engine, compaction });

  // 起動そのものが失敗した場合も、作った置き場を残さない。
  let started: StartedServer;
  try {
    started = startServer({
      config,
      deps: {
        store,
        engine,
        settings,
        mcp: options.mcp ?? createMcpStub(),
        connectors,
        discord,
        routines,
        webSearch: options.webSearch ?? createWebSearchStub(),
        container,
        images,
        files,
        handover,
        envRequests,
        compaction,
        turns,
        broadcast: createConversationBroadcast(),
        catalog: options.catalog ?? createCatalog({ cachePath: join(dir, CATALOG_FILE_NAME) }),
        checkConnection: options.checkConnection ?? createConnectionChecker(),
        listModels: options.listModels ?? createModelLister(),
        dataDir: dir,
      },
    });
  } catch (error) {
    await compaction.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  const harness: ServerHarness = {
    server: started.server,
    portChanged: started.portChanged,
    url: started.server.url.toString(),
    dir,
    store,
    settings,
    settingsPath,
    discord,
    routines,
    images,
    files,
    handover,
    envRequests,
    request: (path, init) => fetch(new URL(path, started.server.url), withClientHeader(init)),
    file: () => readSettingsFile(settingsPath),
  };

  try {
    return await run(harness);
  } finally {
    // 走っているターンと圧縮を止めてから、接続と DB を畳む（本番の shutdown と同じ順）。
    await turns.close();
    await compaction.close();
    connectors.close();
    discord.close();
    await started.server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 待ち時間ゼロで一気に流すモック。全文を待ってから確かめるテストで使う。 */
export function fastMock(): AgentEngine {
  return createMockEngine({ chunkSize: 10_000, delayMs: 0 });
}

/** 待ち受けているポートを取り出す。取れなければテストの前提が崩れているので止める。 */
export function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("サーバのポートが取れていない");
  return server.port;
}

/**
 * 変更系の API は画面の id を要求する。テストでは、明示が無ければ固定の id を付ける。
 * ヘッダを明示したテストは、その指定をそのまま使う。
 */
function withClientHeader(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has(CLIENT_HEADER)) headers.set(CLIENT_HEADER, "test-client");
  return { ...init, headers };
}

/** JSON を返す応答。fetch の差し替えで使う。 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 一時ディレクトリを作り、確かめ終わったら消す。 */
export async function withTempDir<T>(prefix: string, run: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

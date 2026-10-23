import type { ProviderSettings } from "../../data/settings";
import type { McpServerSettings } from "../../data/settings";
import type { SettingsStore } from "../../data/settings";
import type { Store } from "../../data/store";
import type { AgentEngine } from "../../agent/engine";
import type { Compaction } from "../../agent/compaction";
import type { ContainerManager } from "../../computer/container";
import type { EnvRequests } from "../../computer/env";
import type { FileStore } from "../../computer/files";
import type { Handover } from "../../computer/handover";
import type { ImageStore } from "../../computer/images";
import type { McpManager } from "../../mcp/manager";
import type { ConnectorsManager } from "../../connectors/manager";
import type { DiscordWebhooks } from "../../discord/manager";
import { McpServerNotFound } from "../../mcp/manager";
import type { WebSearchManager } from "../../websearch-manager";
import type { Catalog } from "../../provider/catalog";
import type { ConnectionChecker, ProviderModelLister } from "../../provider/connection";
import { AppError } from "../../errors";

/**
 * ハンドラが共有する型と、前提を確かめる小さな関数。
 *
 * ハンドラが必要とする最小限のリクエスト形状をここに置く。Bun 固有の型に依存させないことで、
 * ルーティングと HTTP 処理を分けて読めるようにしている。パラメータを持たないルートでは型引数を省ける。
 */

export type ApiRequest<Params extends Record<string, string> = Record<string, never>> = {
  params: Params;
  signal: AbortSignal;
  headers: Headers;
  text(): Promise<string>;
  formData(): Promise<FormData>;
};

/**
 * 画面の中継のルート。http/server.ts のルート定義（"/api/computer/screen/*"）と同じパスにする。
 * 中継先へ渡すパスは、この接頭辞を落として作る。
 */
export const SCREEN_RELAY_PREFIX = "/api/computer/screen/";

/** 画面の中継のリクエスト。 */
export type ScreenRelayRequest = {
  url: string;
  signal: AbortSignal;
};

/** ハンドラが使う依存の全体。 */
export type ApiDeps = {
  store: Store;
  engine: AgentEngine;
  /** モデルとプロバイダの設定。変更は config.json に書き戻される。 */
  settings: SettingsStore;
  /** MCP サーバーとの接続。設定画面からの操作もここを通す。 */
  mcp: McpManager;
  /** コネクタ（トークン）。設定画面とチャットのカードからの操作がここを通る。 */
  connectors: ConnectorsManager;
  /** Discord の webhook（送信先は Tera ごと）。設定画面とチャットのカードからの操作がここを通る。 */
  discord: DiscordWebhooks;
  /** Web 検索の設定と接続確認。設定画面からの操作もここを通す。 */
  webSearch: WebSearchManager;
  /** podman で動かすコンテナ。設定画面からの起動とリセットもここを通す。 */
  container: ContainerManager;
  /** エージェントが送った画像。画面へ返す。 */
  images: ImageStore;
  /** エージェントが送ったファイル。画面へ返す。 */
  files: FileStore;
  /** ユーザーへ画面を渡す待ち。チャットからの返事をここへ届ける。 */
  handover: Handover;
  /** 環境変数の入力待ち。チャットで入力された値を設定へ書き、モデルには値を返さない。 */
  envRequests: EnvRequests;
  /** 過去の対話の圧縮。ターンの前に走っている分を待ち、ターンの後に次を決める。 */
  compaction: Compaction;
  /** models.dev のカタログ。プロバイダとモデルの一覧はここから取る。 */
  catalog: Catalog;
  /** プロバイダへ接続できるかを確かめる。 */
  checkConnection: ConnectionChecker;
  /** 独自エンドポイントのモデル一覧を取る。 */
  listModels: ProviderModelLister;
  /** データディレクトリ。Tera の作業フォルダを消すときに使う。 */
  dataDir: string;
};

/** Tera が無ければ 404。あれば何もしない。 */
export function requireTera(store: Store, id: string): void {
  if (store.getTera(id) === null) throw new AppError("tera_not_found", 404, `Tera ${id} はありません`);
}

/** プロバイダが設定されていなければ 404。 */
export function requireProvider(settings: SettingsStore, id: string): ProviderSettings {
  const provider = settings.read().providers[id];
  if (provider === undefined) {
    throw new AppError("provider_not_found", 404, `プロバイダ ${id} は設定されていません`);
  }
  return provider;
}

/** MCP サーバーが設定されていなければ 404。 */
export function requireMcpServer(settings: SettingsStore, id: string): McpServerSettings {
  const server = settings.read().mcpServers[id];
  if (server === undefined) throw new McpServerNotFound(id);
  return server;
}

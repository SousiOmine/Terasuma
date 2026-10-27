import type { ToolSet } from "ai";
import type { SentAttachment } from "../../shared/api/message";
import type { McpToolset } from "../mcp/manager";

/**
 * エンジンがツール一式を受け取るための型。
 *
 * ツールの実装（server/tools/*）と、それらを組み立てるエンジン（agent/engine/*）の間に置く。
 * ツール側はこの型だけを知り、エンジンを知らない。
 *
 * ツール一式の型は、どれも AI SDK の ToolSet（ツール名 → 定義）そのもの。ここで各ツールの
 * モジュールから型を借りると、ツール側がこのファイルを参照する向きと合わせて循環する。
 * そのため、ここでは ToolSet をそのまま使い、名前だけを役割ごとに与える。
 */

/** モデルへ渡すツールの供給元。接続を持たないテストでもここを差し替えれば済む。 */
export type ToolsetProvider = {
  toolset(): Promise<McpToolset>;
};

/**
 * コンテナのツールの供給元。ターンの対象の Tera を渡す。
 */
export type ComputerToolsetProvider = {
  toolset(input: { teraId: string }): Promise<ToolSet>;
};

/**
 * コンテナのファイルとシェルのツールの供給元。
 * 相対パスと bash の作業ディレクトリの基準は Tera ごとの作業フォルダなので、ターンごとに teraId を渡す。
 */
export type CodingToolsetProvider = {
  toolset(input: { teraId: string }): ToolSet;
};

/** 新しい Tera を作るツールの供給元。 */
export type TeraToolsetProvider = {
  toolset(): ToolSet;
};

/** MCP サーバーを足す・消すツールの供給元。 */
export type McpManageToolsetProvider = {
  toolset(): ToolSet;
};

/**
 * 画像やファイルをチャットへ添付するツールの供給元。
 * 添付の口はターンごとに差し替わり、相対パスの基準も Tera ごとに変わるので、両方を渡す。
 */
export type AttachmentToolsetProvider = {
  toolset(input: { teraId: string; attach: (attachments: SentAttachment[]) => void }): ToolSet;
};

/**
 * 過去の対話履歴を検索するツールの供給元。
 * 引く履歴はターンの対象の Tera のものなので、ターンごとに teraId を渡す。
 */
export type HistoryToolsetProvider = {
  toolset(input: { teraId: string }): ToolSet;
};

/** スケジュールされた実行（ルーチン）のツール一式。 */
export type RoutineToolset = ToolSet;

/**
 * スケジュールされた実行（ルーチン）のツールの供給元。
 * 扱うルーチンはターンの対象の Tera のものなので、ターンごとに teraId を渡す。
 */
export type RoutineToolsetProvider = {
  toolset(input: { teraId: string }): RoutineToolset;
};

/**
 * Web 検索とページ取得のツールの供給元。
 * 既定の検索プロバイダが未設定なら、空のツール一式を返す。
 */
export type WebSearchToolsetProvider = {
  toolset(): ToolSet;
};

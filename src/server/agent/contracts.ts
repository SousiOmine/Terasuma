import type { ToolSet } from "ai";
import type { SentAttachment } from "../../shared/api/message";
import type { McpToolset } from "../mcp/manager";
import type { AttachmentToolset } from "./tools/attachments";
import type { CodingToolset } from "./tools/coding";
import type { ComputerToolset } from "./tools/computer";
import type { HistoryToolset } from "./tools/history";
import type { TeraToolset } from "./tools/tera";
import type { RoutineToolset } from "../routine/tools";

/**
 * エンジンがツール一式を受け取るための型。
 *
 * ツールの実装（tools/*）と、それらを組み立てるエンジン（engine/）の間に置く。
 * ツール側はこの型だけを知り、エンジンを知らない。
 */

/** モデルへ渡すツールの供給元。接続を持たないテストでもここを差し替えれば済む。 */
export type ToolsetProvider = {
  toolset(): Promise<McpToolset>;
};

/**
 * コンテナのツールの供給元。ターンの対象の Tera を渡す。
 */
export type ComputerToolsetProvider = {
  toolset(input: { teraId: string }): Promise<ComputerToolset>;
};

/**
 * コンテナのファイルとシェルのツールの供給元。
 * 相対パスと bash の作業ディレクトリの基準は Tera ごとの作業フォルダなので、ターンごとに teraId を渡す。
 */
export type CodingToolsetProvider = {
  toolset(input: { teraId: string }): CodingToolset;
};

/** 新しい Tera を作るツールの供給元。 */
export type TeraToolsetProvider = {
  toolset(): TeraToolset;
};

/**
 * 画像やファイルをチャットへ添付するツールの供給元。
 * 添付の口はターンごとに差し替わり、相対パスの基準も Tera ごとに変わるので、両方を渡す。
 */
export type AttachmentToolsetProvider = {
  toolset(input: { teraId: string; attach: (attachments: SentAttachment[]) => void }): AttachmentToolset;
};

/**
 * 過去の対話履歴を検索するツールの供給元。
 * 引く履歴はターンの対象の Tera のものなので、ターンごとに teraId を渡す。
 */
export type HistoryToolsetProvider = {
  toolset(input: { teraId: string }): HistoryToolset;
};

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

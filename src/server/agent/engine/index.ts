import type { AppConfig } from "../../../config";
import type { ModelSettings } from "../../data/settings";
import type { ConnectorToolsetProvider } from "../../connectors/tools";
import type { DiscordToolsetProvider } from "../../discord/tools";
import type { ImageStore } from "../../computer/images";
import type { CatalogSnapshot } from "../../provider/catalog";
import type { ReplyLanguage } from "../../../shared/language";
import type { ChatMessage, MessagePart, SentAttachment, TokenUsage } from "../../../shared/api/message";
import type {
  AttachmentToolsetProvider,
  CodingToolsetProvider,
  ComputerToolsetProvider,
  HistoryToolsetProvider,
  TeraToolsetProvider,
  ToolsetProvider,
  WebSearchToolsetProvider,
} from "../contracts";
import type { TeraContext } from "../prompt";
import type { IdentityStore } from "../identity";
import type { Skill, SkillFileStore } from "../skill-types";
import { createAiSdkEngine } from "./sdk";
import { createMockEngine } from "./mock";

/**
 * LLM 呼び出しのエンジン。
 *
 * ここは「何を渡し、何を受け取るか」だけを持つ。AI SDK の呼び出し方は ./sdk.ts、
 * ストリームの読み替えは ./stream.ts、ツール結果の変換は ./output.ts、
 * モックは ./mock.ts にある。実装を差し替えるときは、この型を満たすものを作る。
 */

/** モデルから流れてくる出来事。画面へ流す単位でもある。 */
export type EngineEvent =
  /** モデルのステップが始まった（最初のステップでも流れる）。 */
  | { type: "step-start" }
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; part: Extract<MessagePart, { type: "tool-call" }> }
  | { type: "tool-result"; part: Extract<MessagePart, { type: "tool-result" }> }
  /** 1 ターンのステップの上限で打ち切られた。 */
  | { type: "step-limit" };

export type EngineStream = {
  events: AsyncIterable<EngineEvent>;
  /**
   * 最後のモデル呼び出し 1 回分のトークン消費。ストリーム終了時に解決する。
   * 取得できない場合は null。
   */
  usage: Promise<TokenUsage | null>;
};

export type EngineInput = {
  /** Tera の文脈（畳んだ要約と、まだ畳んでいない生の履歴）。末尾が今回のユーザー発言。 */
  context: TeraContext;
  signal: AbortSignal;
  /** このターンの Tera。コンテナの引き受け（computer_ask_user）をこの単位で待つ。 */
  teraId: string;
  /** 返事を書く言語。設定画面の言語を使い、ユーザープロンプトの末尾で指示する。 */
  replyLanguage: ReplyLanguage;
  /**
   * エージェントが画像やファイルをチャットへ添付する口。chat_attach ツールから呼ばれる。
   * モデルの本文は text-delta として流れ、ターンの側が画面へ出す。
   */
  attach: (attachments: SentAttachment[]) => void;
  /**
   * 利用者がターンの途中で送った発言を取り出す口。モデルを呼ぶたびに呼び、
   * 届いていれば user メッセージとして文脈の末尾へ足す。
   * 発言はターンの側がすでに保存しているので、ここではモデルへ渡す本文にするだけ。
   */
  takeSteering: () => readonly ChatMessage[];
};

/**
 * ツールを使わない 1 回の呼び出し。過去の対話の要約（圧縮）が使う。
 * 会話のターンとは別に走るので、ターンの中断（停止）には巻き込まれない。
 */
export type CompleteInput = {
  /** この呼び出しだけの system プロンプト。 */
  instructions: string;
  prompt: string;
  /** 要約の期限。過ぎたら打ち切る。 */
  signal: AbortSignal;
  /** 出力の上限。要約が際限なく長くならないようにする。 */
  maxOutputTokens: number;
};

/**
 * LLM 呼び出しのインタフェース。
 * AI SDK に依存する部分はこのインタフェースの内側だけにあるので、実装の差し替え
 * （承認フローの追加、プロファイルごとのエージェント切り替え）はここを実装し直すだけで済む。
 */
export interface AgentEngine {
  readonly name: string;
  stream(input: EngineInput): Promise<EngineStream>;
  /** ツールを使わない 1 回の生成。過去の対話の要約に使う。 */
  complete(input: CompleteInput): Promise<string>;
}

/** 設定を読む口。設定画面から変わるので、呼び出しのたびに読む。 */
export type SettingsReader = {
  read(): ModelSettings;
};

/** カタログを読む口。カタログは起動後に取り直すので、呼び出しのたびに読む。 */
export type CatalogReader = {
  snapshot(): CatalogSnapshot | null;
};

export function createEngine(options: {
  config: AppConfig;
  settings: SettingsReader;
  mcp: ToolsetProvider;
  computer: ComputerToolsetProvider;
  /** 画像やファイルをチャットへ添付するツール。 */
  attachments: AttachmentToolsetProvider;
  /** 過去の対話履歴を検索するツール。 */
  history: HistoryToolsetProvider;
  /** Web 検索とページ取得のツール。 */
  webSearch: WebSearchToolsetProvider;
  /** コネクタ（トークン）のツール。 */
  connectors: ConnectorToolsetProvider;
  /** Discord の webhook（送信先は Tera ごと）のツール。 */
  discord: DiscordToolsetProvider;
  /** 新しい Tera を作るツール。作る先（作業フォルダの親）はアプリが決める。 */
  tera: TeraToolsetProvider;
  /** コンテナのファイルとシェルのツール。相対パスと bash の cwd が Tera ごとに違うので、ターンごとに組む。 */
  coding: CodingToolsetProvider;
  /** 撮った画像の置き場。履歴から画像を読み直してモデルへ渡す。 */
  images: ImageStore;
  /** models.dev のカタログ。プロバイダの呼び出し方を決めるのに使う。 */
  catalog: CatalogReader;
  /** エージェントが作ったスキルの置き場。 */
  skills: SkillFileStore;
  /** Tera の identity の読み書き。system プロンプトに載せる版と、書いた版を持つ。 */
  identity: IdentityStore;
  /** 接続状態などで変わる、組み込みの追加スキル。呼び出しのたびに評価する。 */
  extraSkills?: () => readonly Skill[];
}): AgentEngine {
  if (options.config.engine === "mock") return createMockEngine();
  return createAiSdkEngine({
    settings: options.settings,
    mcp: options.mcp,
    computer: options.computer,
    attachments: options.attachments,
    history: options.history,
    webSearch: options.webSearch,
    connectors: options.connectors,
    discord: options.discord,
    tera: options.tera,
    coding: options.coding,
    images: options.images,
    catalog: options.catalog,
    skills: options.skills,
    identity: options.identity,
    extraSkills: options.extraSkills,
  });
}

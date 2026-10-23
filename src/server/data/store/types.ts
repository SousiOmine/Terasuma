import type {
  ChatAttachment,
  ChatMessage,
  MessagePart,
  MessageRole,
  Tera,
  TokenUsage,
} from "../../../shared/api/message";

/**
 * 保存する前の形と、読み書きの口。
 *
 * Store は 4 つの役割の交差にする。呼び出し側は使う役割だけを受け取れるので、
 * 「履歴を読むだけ」のモジュールに close や identity まで渡さずに済む。
 */

/**
 * 既定の Tera。起動時に 1 体だけ用意する。
 * 増やす導線はまだ無いので、会話の持ち主は当面この 1 つになる。
 */
export const DEFAULT_TERA_ID = "default";
export const DEFAULT_TERA_NAME = "Tera";

/**
 * 既定の identity。Tera が自分で書き換える出発点になる。
 * system プロンプトに常に載るので、短く保つ。
 */
export const DEFAULT_TERA_IDENTITY = [
  "# Role",
  "",
  "You are a general-purpose assistant for the user. You run on their own machine and answer in this chat.",
  "You help with whatever they bring: questions, writing and changing code, the desktop container, and web research.",
].join("\n");

export type AppendMessageInput = {
  id: string;
  teraId: string;
  role: MessageRole;
  /** ユーザーが書いた本文。assistant では空で、表示する本文は parts の text が持つ。 */
  content: string;
  /** ユーザーが添付したファイル。無ければ null。 */
  attachments?: ChatAttachment[] | null;
  /** ツール呼び出しを含むときだけ渡す。含まないメッセージは null。 */
  parts?: MessagePart[] | null;
  usage?: TokenUsage | null;
};

/** 履歴を読むページ。before は「この seq より前」を表し、null なら最新から読む。 */
export type MessagePageQuery = {
  /** 返す件数の上限。 */
  limit: number;
  /** この seq より前だけを読む。null なら最新から。 */
  before: number | null;
};

/**
 * Tera の過去のやり取りを畳んだ要約（Compaction）。
 * 会話が長くなっても、モデルへ渡す文脈を有界に保つ。
 */
export type CompactionState = {
  /** 定型（Goal / Progress など）で書かれた要約。まだ 1 度も畳んでいなければ空文字。 */
  summary: string;
  /** この seq までのメッセージは要約に畳み込まれた。まだ畳んでいなければ 0。 */
  throughSeq: number;
  /** 畳んだ時点の文脈のトークンの目安。 */
  tokensBefore: number;
  /** 要約を作った時刻。epoch ミリ秒。 */
  createdAt: number;
};

/**
 * Tera の identity（自分の役割と、必要な知識）。
 *
 * content は Tera が identity ツールで書いた最新の本文。
 * applied は system プロンプトに載っている版で、最後に圧縮が要約を書き換えた時点の content が入る。
 * system プロンプトは applied だけを読むので、書き換えただけでは次の圧縮まで変わらない。
 */
export type TeraIdentity = {
  content: string;
  applied: string;
};

/** Tera の一覧と、起動時の用意。 */
export type TeraDirectory = {
  listTeras(): Tera[];
  getTera(id: string): Tera | null;
  /**
   * 無ければ作る。既にあれば名前も作成日時も変えない（起動のたびに呼ばれる）。
   * identity も無ければ既定の役割で作り、既にあれば変えない。
   */
  ensureTera(id: string, name: string): Tera;
};

/** 履歴を 1 ページ読んだ結果。画面へ返す前に、表示に使う部品だけへ絞る。 */
export type MessagePageResult = {
  /** 古い順。 */
  messages: ChatMessage[];
  /** このページより古いメッセージが残っているか。 */
  hasMore: boolean;
};

/** まだ畳んでいない履歴の、軽い統計。JSON を読まずに、圧縮の要否をざっくり見る。 */
export type PendingStats = {
  count: number;
  /** 最後のメッセージの時刻。1 件も無ければ null。 */
  lastCreatedAt: number | null;
  /** 本文と部品の文字数の合計。トークンの目安に使う。 */
  chars: number;
};

/** 履歴の追記と読み出し。 */
export type MessageLog = {
  /**
   * 履歴を新しい側から 1 ページ読む（返す並びは古い順）。
   * limit は件数の上限、before は「この seq より前」を表す。
   */
  listMessagesPage(teraId: string, page: MessagePageQuery): MessagePageResult;
  /** seq より後のメッセージ（古い順）。まだ畳んでいない生の履歴を取り出す。 */
  listMessagesSince(teraId: string, seq: number): ChatMessage[];
  /**
   * 期間で絞ったメッセージ（古い順）。since 以上 until 未満。
   * 端は null で「制限しない」を表す（0 時と 0 を取り違えないよう、時刻ではなく null で表す）。
   */
  listMessagesBetween(teraId: string, range: { since: number | null; until: number | null }): ChatMessage[];
  /** 履歴の末尾に追記する。Tera の行が先に存在している必要がある。 */
  appendMessage(input: AppendMessageInput): ChatMessage;
  /** seq より後の履歴の統計。全行を開かずに、件数・最後の時刻・文字数を返す。 */
  readPendingStats(teraId: string, afterSeq: number): PendingStats;
};

/** 過去のやり取りを畳んだ要約。 */
export type CompactionStore = {
  readCompaction(teraId: string): CompactionState;
  /** 要約を置き換える。throughSeq は呼ぶ側が前に進める（戻さない）。 */
  writeCompaction(teraId: string, state: CompactionState): void;
};

/** Tera の identity。 */
export type TeraIdentityStore = {
  /** Tera の identity を読む。まだ書かれていなければ、どちらも空。 */
  readIdentity(teraId: string): TeraIdentity;
  /** Tera が書いた identity を置き換える。system プロンプト用の版（applied）は変えない。 */
  writeIdentity(teraId: string, content: string): TeraIdentity;
  /**
   * 書かれている identity を、system プロンプト用の版へ切り替える。
   * 圧縮が要約を書き換えたときに呼ぶ。変わったときだけ true。
   */
  applyIdentity(teraId: string): boolean;
};

export type Store = TeraDirectory & MessageLog & CompactionStore & TeraIdentityStore & { close(): void };

export type CreateStoreOptions = {
  /** テストで時刻を固定するために差し替える。 */
  now?: () => number;
};

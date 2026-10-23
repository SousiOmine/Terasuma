/**
 * 会話の型。サーバの保存、SSE のフレーム、画面の表示で共有する。
 * 保存する形（DB の行）は server/data/store が持ち、ここには外へ出す形だけを置く。
 */

import type { ApiErrorCode } from "./error";

export type MessageRole = "user" | "assistant";

/** モデル呼び出し 1 回分のトークン消費。cachedInputTokens はプロンプトキャッシュのヒット分。 */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

/**
 * エージェントがチャットへ添付したファイル 1 件。
 * 実体は Terasuma のデータディレクトリに置き、画面は URL だけで読む。
 */
export type SentAttachment = {
  /** 画面に出す名前。 */
  name: string;
  /** バイト数。 */
  size: number;
  /** ブラウザから開く URL。画像はそのまま表示し、それ以外はダウンロードする。 */
  url: string;
  /** 画像のときだけ、表示に使う縦横。画像でなければ null。 */
  image: { width: number; height: number } | null;
};

/** モデルの本文。画面にそのまま出す。 */
export type TextPart = {
  type: "text";
  text: string;
  /** 本文が始まった時刻。epoch ミリ秒。 */
  at: number;
};

/** エージェントがチャットへ添付した画像・ファイルのまとまり。 */
export type AttachmentPart = {
  type: "attachment";
  /** 一緒に添付したファイル（添付した順）。 */
  attachments: SentAttachment[];
  /** 添付した時刻。epoch ミリ秒。 */
  at: number;
};

/** 画面に出すシステムの注記（操作の上限で止まった、など）。 */
export type NoticePart = {
  type: "notice";
  text: string;
  at: number;
};

/** 画面に出す部品。 */
export type VisiblePart = TextPart | AttachmentPart | NoticePart;

/**
 * 1 ターン分の記録を組み立てている部品。
 *
 * text・attachment・notice は画面に出す。ツールの呼び出しと結果は内部の記録で、
 * 画面には出さずモデルへ渡す履歴にだけ使う。順序を保ったまま部分ごとに持つ。
 */
export type MessagePart =
  | TextPart
  | AttachmentPart
  | NoticePart
  | {
      type: "tool-call";
      /** モデルが発行した呼び出し id。結果と突き合わせる。 */
      id: string;
      /** 接続している MCP サーバーの id。 */
      server: string;
      /** MCP サーバーが公開しているツール名。 */
      tool: string;
      /** モデルが組み立てた引数。 */
      args: unknown;
    }
  | {
      type: "tool-result";
      id: string;
      server: string;
      tool: string;
      /** ツールがエラーを返したかどうか。 */
      failed: boolean;
      /** ツールが返した内容（モデルへ渡るのと同じ文字列）。 */
      output: string;
      /** ツールが返した画像（返した順）。画像を返さないツールでは無い。 */
      images?: ImageRef[];
    };

/**
 * 保存した画像の在り処。
 * 実体はデータディレクトリにファイルで置き、メッセージにはこの参照だけを持たせる
 * （base64 を保存すると、会話を読み直すたびに大きな文字列を運ぶことになる）。
 */
export type ImageRef = {
  /** ファイル名になる。画像の中身の sha256。 */
  sha256: string;
  /** image/png、image/jpeg、image/gif、image/webp のいずれか。 */
  mime: string;
  width: number;
  height: number;
};

/**
 * 画面に出す添付ファイル。
 * name と size は画面用。path はモデル向けの案内にだけ使い、画面は参照しない。
 */
export type ChatAttachment = {
  /** 画面に出す名前。 */
  name: string;
  /** バイト数。 */
  size: number;
  /** コンテナの中の絶対パス。モデルへ渡す案内にだけ使う。 */
  path: string;
};

export type ChatMessage = {
  id: string;
  /** このメッセージを持つ Tera。 */
  teraId: string;
  /** Tera の中の連番。1 から始まり、履歴の並び順を確定させる。 */
  seq: number;
  role: MessageRole;
  /**
   * ユーザーが書いた本文。
   * assistant のメッセージでは常に空で、画面に出す本文は parts の text が持つ。
   */
  content: string;
  /**
   * ユーザーが添付したファイル。無ければ null。
   * モデルへは、content とこの配列から案内を組み立てて渡す。
   */
  attachments: ChatAttachment[] | null;
  /**
   * そのターンに起きたことの記録。assistant では常に配列（空のこともある）。
   * ユーザーのメッセージでは null。
   *
   * text・attachment・notice は画面に出す。ツールの呼び出しと結果は内部の記録で、
   * 画面には出さずモデルへ渡す履歴にだけ使う。
   * 画面へ渡すときは、表示に使う部分だけに絞る（server/agent/message-view.ts）。
   */
  parts: MessagePart[] | null;
  /** epoch ミリ秒 */
  createdAt: number;
  usage: TokenUsage | null;
};

/** 画面へ返す添付ファイル。コンテナの中のパスは、モデル向けの案内にだけ使うので含めない。 */
export type ChatAttachmentView = {
  name: string;
  size: number;
};

/**
 * 画面へ返すメッセージ。
 *
 * 保存した記録（ChatMessage）から、画面に使わないもの（usage、添付のコンテナ内パス）を落とす。
 * 保存とモデルの文脈は ChatMessage のまま扱う。
 */
export type ChatMessageView = {
  id: string;
  teraId: string;
  seq: number;
  role: MessageRole;
  content: string;
  attachments: ChatAttachmentView[] | null;
  /** 表示に使う部品だけ（本文・添付・注記・chat_ui の呼び出し）。 */
  parts: MessagePart[] | null;
  createdAt: number;
};

/**
 * 履歴を 1 ページずつ読むときの応答。
 * limit は新しい側から数えた件数、hasMore はそのページより古い発言が残っているか。
 */
export type MessagePage = {
  /** 古い順。 */
  messages: ChatMessageView[];
  /** このページより古いメッセージが残っているか。 */
  hasMore: boolean;
};

/**
 * エージェント 1 体。会話の履歴を 1 本だけ持ち、モデルへ何を渡すかはこの単位で決める。
 * 既定の Tera は起動時に用意し、ほかの Tera はエージェントが tera_create ツールで作る。
 */
export type Tera = {
  id: string;
  /** 画面に出す名前。 */
  name: string;
  /** epoch ミリ秒 */
  createdAt: number;
  updatedAt: number;
};

/**
 * 1 ターン分のストリーミングで流れるイベント。
 *
 * モデルの本文は、区切りごとに text パートとして assistant-message で流す。
 * 画像やファイルの添付は attachment パートとして流す。どちらも少しずつではなく、
 * 区切りが付いた時点で 1 件ずつ流す。ツール呼び出しと結果は、引き受け
 * （computer_ask_user）の始まりと終わりを見るために流す。
 */
export type ChatEvent =
  | { type: "user-message"; message: ChatMessageView }
  | { type: "assistant-start"; id: string; createdAt: number }
  | { type: "assistant-message"; id: string; part: TextPart | AttachmentPart }
  | { type: "notice"; id: string; part: NoticePart }
  | { type: "tool-call"; id: string; part: Extract<MessagePart, { type: "tool-call" }> }
  | { type: "tool-result"; id: string; part: Extract<MessagePart, { type: "tool-result" }> }
  | { type: "assistant-done"; message: ChatMessageView }
  | { type: "error"; code: ApiErrorCode; detail: string | null };

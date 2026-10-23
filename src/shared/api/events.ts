import type { ChatEvent } from "./message";

/**
 * 会話の購読（同じ Tera を開いている画面どうしの同期）の契約。
 *
 * 画面は会話を開いている間、その Tera の購読を 1 本張る。サーバは、どの画面で起きた
 * ターンの出来事も、その Tera を開いているほかの画面へそのまま流す。
 */

/**
 * 画面（タブ）が、自分の id をサーバへ伝えるヘッダ。
 *
 * 送った画面は、送信の応答として同じ出来事を受け取っている。購読へも配ると二重になるので、
 * サーバはこの id の購読を飛ばす。1 回の読み込みごとに作り直す。
 */
export const CLIENT_HEADER = "x-terasuma-client";

/**
 * 購読を始めたときに 1 度だけ届く、いまの状態。
 *
 * 購読を張るまでの間に起きたことを、画面が知るために送る。
 * lastSeq より新しい発言が手元に無ければ、履歴を読み直せばよい。
 */
export type ConversationSync = {
  type: "sync";
  /** その Tera で保存されている最新の発言の連番。まだ 1 件も無ければ 0。 */
  lastSeq: number;
  /** いまターンが走っているかどうか（ほかの画面で始まったものも含む）。 */
  turnRunning: boolean;
};

/**
 * 会話の購読で流れるイベント。
 *
 * sync のあとに続く ChatEvent は、走っているターンの出来事そのもの。ターンが走っていれば、
 * 途中から購読した画面へも始まったところから流れるので、どの画面でも同じ内容になる。
 */
export type ConversationEvent =
  | ConversationSync
  | {
      /**
       * ターンが終わったが、終わりを伝えるイベント（assistant-done / error）を流せなかった。
       * 送った画面が途中で離れた場合に届く。受け取った画面は、履歴を読み直して状態を揃える。
       */
      type: "turn-ended";
    }
  | ChatEvent;

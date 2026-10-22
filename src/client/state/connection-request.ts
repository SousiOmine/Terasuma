import { signal } from "@preact/signals";
import type { ConnectionFlowView } from "../../shared/types";
import * as api from "../lib/api";
import { ApiError } from "../lib/http";
import { clearChatError, showChatError } from "./failure";

/**
 * チャットの認証カード。
 *
 * エージェントが computer_connect_app を呼んだときに始まり、認可の完了・失敗・取り消しで終わる。
 * 環境変数の入力欄と同じく、ターンの途中にチャットの入力欄の上へ出す。
 * コードはユーザーが認可ページへ入力する。トークンはこの状態を通らない。
 */

export type ConnectionRequestPhase =
  /** サーバーにコードを作ってもらっている。 */
  | "starting"
  /** コードを出して、ユーザーの認可を待っている。 */
  | "waiting"
  /** Client ID が未設定。設定への導線を出す。 */
  | "setup_required"
  /** 認可を始められなかった、または認可されなかった。 */
  | "failed";

export type ConnectionRequest = {
  /** カードを出したツール呼び出しの id。結果と突き合わせる。 */
  callId: string;
  /** 接続するアプリの id（"github"）。 */
  provider: string;
  /** モデルが書いた理由。無ければ null。 */
  reason: string | null;
  /** アプリの表示名。サーバーから届くまで null。 */
  providerName: string | null;
  /** 認可のコード。始まるまで null。 */
  flow: ConnectionFlowView | null;
  phase: ConnectionRequestPhase;
};

export const connectionRequest = signal<ConnectionRequest | null>(null);

/** 取り消しの送信中。同じ操作を 2 度送らせない。 */
export const connectionRequestSending = signal(false);

/** いまカードを出しているツール呼び出しの id。出していなければ null。 */
let requestCallId: string | null = null;

/** 認可の待ちを始める。サーバーへの要求は startConnectionRequestFlow が行う。 */
export function beginConnectionRequest(callId: string, provider: string, reason: string | null): void {
  requestCallId = callId;
  connectionRequest.value = {
    callId,
    provider,
    reason,
    providerName: null,
    flow: null,
    phase: "starting",
  };
  connectionRequestSending.value = false;
}

/**
 * 結果が届いたら終える。
 * 成功ではカードを畳み、失敗では残す（Client ID が無いときの設定への導線を消さない）。
 */
export function endConnectionRequest(callId: string, failed: boolean): void {
  if (requestCallId !== callId) return;

  if (!failed) {
    resetConnectionRequest();
    return;
  }

  const request = connectionRequest.value;
  if (request === null) return;
  connectionRequest.value = {
    ...request,
    phase: request.phase === "setup_required" ? "setup_required" : "failed",
  };
}

/** カードを畳む。ターンの終了・Tera の切り替え・閉じるで呼ぶ。 */
export function resetConnectionRequest(): void {
  requestCallId = null;
  connectionRequest.value = null;
  connectionRequestSending.value = false;
}

/** サーバーにコードを作ってもらい、カードに出す。カードを出したときに 1 度だけ呼ぶ。 */
export async function startConnectionRequestFlow(): Promise<void> {
  const request = connectionRequest.value;
  if (request === null || request.phase !== "starting") return;

  try {
    const result = await api.authorizeConnection(request.provider);
    const current = connectionRequest.value;
    // 待っている間にターンが終わった（カードが畳まれた）場合は何もしない。
    if (current === null || current.callId !== request.callId) return;

    if (result.flow === null) {
      // すでに接続済み。ツールの結果がすぐ届くので、カードはそのまま待つ。
      connectionRequest.value = { ...current, phase: "waiting" };
      return;
    }

    connectionRequest.value = {
      ...current,
      providerName: result.flow.providerName,
      flow: result.flow,
      phase: "waiting",
    };
  } catch (error) {
    const current = connectionRequest.value;
    if (current === null || current.callId !== request.callId) return;

    const setupRequired = error instanceof ApiError && error.code === "connection_not_configured";
    connectionRequest.value = { ...current, phase: setupRequired ? "setup_required" : "failed" };
  }
}

/** 認可をやめる。サーバーの待ちも止める。 */
export async function cancelConnectionRequest(): Promise<void> {
  const request = connectionRequest.value;
  if (request === null || request.flow === null || connectionRequestSending.value) return;

  clearChatError();
  connectionRequestSending.value = true;
  try {
    await api.cancelConnectionFlow(request.provider);
    resetConnectionRequest();
  } catch (error) {
    showChatError(error);
  } finally {
    connectionRequestSending.value = false;
  }
}

import { signal } from "@preact/signals";
import { cancelConnectionWait, saveConnectionToken, savingToken } from "./connections";

/**
 * チャットの接続カード。
 *
 * エージェントが computer_connect_app を呼んだときに始まり、トークンの保存が終わるまで続く。
 * トークンはサーバーへ直接送り、モデルの文脈には載せない。
 * 待つのはトークンの保存だけなので、状態は「入力待ち」と「失敗」だけになる。
 */

export type ConnectionRequestPhase =
  /** トークンの入力を待っている。 */
  | "waiting"
  /** 接続できなかった。 */
  | "failed";

export type ConnectionRequest = {
  /** カードを出したツール呼び出しの id。結果と突き合わせる。 */
  callId: string;
  /** 接続するアプリの id（"github"）。 */
  provider: string;
  /** モデルが書いた理由。無ければ null。 */
  reason: string | null;
  phase: ConnectionRequestPhase;
};

export const connectionRequest = signal<ConnectionRequest | null>(null);

/** いまカードを出しているツール呼び出しの id。出していなければ null。 */
let requestCallId: string | null = null;

/** カードを出す。 */
export function beginConnectionRequest(callId: string, provider: string, reason: string | null): void {
  requestCallId = callId;
  connectionRequest.value = { callId, provider, reason, phase: "waiting" };
}

/**
 * 結果が届いたら終える。
 * 成功ではカードを畳み、失敗では残す（もう一度試す導線を消さない）。
 */
export function endConnectionRequest(callId: string, failed: boolean): void {
  if (requestCallId !== callId) return;

  if (!failed) {
    resetConnectionRequest();
    return;
  }

  const request = connectionRequest.value;
  if (request === null) return;
  connectionRequest.value = { ...request, phase: "failed" };
}

/** カードを畳む。ターンの終了・Tera の切り替え・閉じるで呼ぶ。 */
export function resetConnectionRequest(): void {
  requestCallId = null;
  connectionRequest.value = null;
}

/** カードのトークンを保存する。サーバーが確かめてから保存する。 */
export async function saveConnectionRequestToken(token: string): Promise<void> {
  const request = connectionRequest.value;
  if (request === null || savingToken.value === request.provider) return;

  await saveConnectionToken(request.provider, token);
}

/** 接続をやめる。サーバーの待ちも止める。 */
export async function cancelConnectionRequest(): Promise<void> {
  const request = connectionRequest.value;
  if (request === null || savingToken.value === request.provider) return;

  await cancelConnectionWait(request.provider);
  resetConnectionRequest();
}

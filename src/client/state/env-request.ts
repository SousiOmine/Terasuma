import { signal } from "@preact/signals";
import * as api from "../lib/api";
import { clearChatError, showChatError } from "./failure";
import { activeTeraId } from "./session";

/**
 * 環境変数の入力欄。
 *
 * エージェントが computer_set_env を呼んだときに始まり、入力か取り消しで終わる。
 * 値はこの状態と API の呼び出しの中だけを通り、会話にもモデルの文脈にも残さない。
 * ふだんのチャット入力欄とは別に持つ（チャットへ書いた文はモデルへ渡ってしまうため）。
 */

/** いま入力を待っているかどうか。 */
export const envRequestActive = signal(false);

/** 入力してもらう変数名。待っていないときは null。 */
export const envRequestName = signal<string | null>(null);

/** 何に使うかの説明（モデルが書く）。無ければ null。 */
export const envRequestDescription = signal<string | null>(null);

/** 送信中かどうか。送っている間は、同じ値を 2 度送らせない。 */
export const envRequestSending = signal(false);

/** いま入力欄を出しているツール呼び出しの id。出していなければ null。 */
let envRequestCallId: string | null = null;

/** 入力を始める。 */
export function beginEnvRequest(callId: string, name: string, description: string | null): void {
  envRequestCallId = callId;
  envRequestName.value = name;
  envRequestDescription.value = description;
  envRequestSending.value = false;
  envRequestActive.value = true;
}

/**
 * 入力を終える。
 * 終えるのは、始めた呼び出し自身の結果が届いたときだけ
 * （並んで走った別のツールの結果で、入力欄が消えないようにする）。
 */
export function endEnvRequest(callId: string): void {
  if (envRequestCallId !== callId) return;
  resetEnvRequest();
}

/**
 * 入力欄を畳む。ターンが終わったとき（停止やタブの切断を含む）と、
 * 別の Tera を開いたときにも呼ぶ（結果が届かないまま待ち続けないようにする）。
 */
export function resetEnvRequest(): void {
  envRequestCallId = null;
  envRequestActive.value = false;
  envRequestName.value = null;
  envRequestDescription.value = null;
  envRequestSending.value = false;
}

/**
 * 入力された値を送る。受け付けられたら true。
 * 値はここからサーバへ直接渡り、この関数を抜けたあとは状態にも残さない。
 */
export async function submitEnvValue(value: string): Promise<boolean> {
  const teraId = activeTeraId.value;
  const name = envRequestName.value;
  if (teraId === null || name === null || envRequestSending.value) return false;
  if (value.trim().length === 0) return false;

  clearChatError();
  envRequestSending.value = true;
  try {
    await api.answerEnvRequest(teraId, { kind: "value", name, value });
    // 保存できたので、結果が届くのを待たずに閉じる（同じ値を 2 度送らせない）。
    resetEnvRequest();
    return true;
  } catch (error) {
    showChatError(error);
    return false;
  } finally {
    envRequestSending.value = false;
  }
}

/** 入力をやめる。サーバ側の待ちは失敗として終わり、モデルにはそう伝わる。 */
export async function cancelEnvRequest(): Promise<void> {
  const teraId = activeTeraId.value;
  const name = envRequestName.value;
  if (teraId === null || name === null || envRequestSending.value) return;

  clearChatError();
  envRequestSending.value = true;
  try {
    await api.answerEnvRequest(teraId, { kind: "cancel", name });
    resetEnvRequest();
  } catch (error) {
    showChatError(error);
  } finally {
    envRequestSending.value = false;
  }
}

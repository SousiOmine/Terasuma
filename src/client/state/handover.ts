import { signal } from "@preact/signals";
import * as api from "../lib/api";
import { clearChatError, showChatError } from "./failure";
import { activeTeraId } from "./session";

/**
 * コンピュータの画面（右ペイン）と、ユーザーへの引き受け。
 *
 * 引き受けは、エージェントが computer_ask_user を呼んだときに始まり、
 * 返事か「操作を完了した」で終わる。待っている間だけ画面を操作できる。
 */

/**
 * 右ペイン（コンテナの画面）を開いているかどうか。既定は閉じている。
 * 閉じている間は noVNC の接続も張らない（見ていない画面のために繋ぎっぱなしにしない）。
 */
export const computerPaneOpen = signal(false);

/**
 * 画面を操作できるかどうか。
 * ふだんは見るだけで、エージェントから引き受けている間だけ操作できる。
 */
export const computerViewOnly = signal(true);

/**
 * いまユーザーへ画面を渡しているかどうか。
 * エージェントが computer_ask_user を呼んだ時点で立ち、結果が届くと下りる。
 */
export const handoverActive = signal(false);

/**
 * ユーザーへ見せる頼み。渡していないときは null。
 * 何を頼むかはモデルが書くので空のこともあるため、待ちの有無は handoverActive で見る。
 */
export const handoverQuestion = signal<string | null>(null);

/** 右ペインを開く。引き受けが始まったときにも使う。 */
export function openComputerPane(): void {
  computerPaneOpen.value = true;
}

/** 右ペインを閉じる。 */
export function closeComputerPane(): void {
  computerPaneOpen.value = false;
}

/** チャットの右上のボタン。 */
export function toggleComputerPane(): void {
  computerPaneOpen.value = !computerPaneOpen.value;
}

/**
 * 引き受けの返事を届ける。送った文は、そのまま computer_ask_user の戻り値になる。
 * これが済むと、ターンの中でツールの結果が流れてくる（画面も見るだけに戻る）。
 */
export async function answerHandover(answer: { kind: "done" } | { kind: "text"; text: string }): Promise<void> {
  const teraId = activeTeraId.value;
  if (teraId === null || !handoverActive.value) return;

  clearChatError();
  try {
    await api.answerHandover(teraId, answer);
  } catch (error) {
    showChatError(error);
  }
}

/** 引き受けを始める。ペインを開き、操作できるようにする。 */
export function beginHandover(question: string | null): void {
  handoverActive.value = true;
  handoverQuestion.value = question;
  computerViewOnly.value = false;
  openComputerPane();
}

/** 引き受けを終える。見るだけに戻す。 */
export function endHandover(): void {
  handoverActive.value = false;
  handoverQuestion.value = null;
  computerViewOnly.value = true;
}

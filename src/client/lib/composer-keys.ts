/**
 * 送信のキー操作の判定。
 * Composer から切り出して、ブラウザを介さずにテストできるようにしてある。
 *
 * チャットアプリと同じく、Enter で送信し、Shift + Enter で改行する。
 * 日本語入力の変換確定の Enter を送信と勘違いしないよう、isComposing を見る。
 */
export type SendKeyEvent = {
  key: string;
  shiftKey: boolean;
  /** 日本語入力の変換中かどうか。確定の Enter を送信と勘違いしないために見る。 */
  isComposing: boolean;
};

export function isSendKey(event: SendKeyEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

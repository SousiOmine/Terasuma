/**
 * 送信のキー操作の判定。
 * Composer から切り出して、ブラウザを介さずにテストできるようにしてある。
 *
 * Enter と Shift + Enter は改行に使い、送信は Ctrl（macOS では Cmd）+ Enter にする。
 * そのため、判定に shiftKey は要らない（Shift が押されていても送信にはならない）。
 */
export type SendKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  /** 日本語入力の変換中かどうか。確定の Enter を送信と勘違いしないために見る。 */
  isComposing: boolean;
};

export function isSendKey(event: SendKeyEvent): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing;
}

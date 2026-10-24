/**
 * 送信のキー操作の判定。
 * Composer から切り出して、ブラウザを介さずにテストできるようにしてある。
 *
 * 長い文章を書くときに誤って送らないよう、Enter は改行のままにし、Ctrl + Enter で送信する。
 * 日本語入力の変換確定の Enter を送信と勘違いしないよう、isComposing を見る。
 */
export type SendKeyEvent = {
  key: string;
  shiftKey: boolean;
  /** 押されている間だけ送る（Ctrl + Enter）。Shift は改行のままなので見ない。 */
  ctrlKey: boolean;
  /** 日本語入力の変換中かどうか。確定の Enter を送信と勘違いしないために見る。 */
  isComposing: boolean;
};

export function isSendKey(event: SendKeyEvent): boolean {
  return event.key === "Enter" && event.ctrlKey && !event.isComposing;
}

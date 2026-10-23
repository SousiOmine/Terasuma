/**
 * Discord の webhook の設定と、その状態。
 *
 * 送信先の webhook は Tera ごとに 1 つ持つ。URL そのものは秘密（そのチャンネルへ投稿できる権利）なので
 * 画面へは返さず、接続済みかどうかと、確かめたときに分かった webhook の名前・チャンネル ID だけを返す。
 */

/** Tera 1 体分の webhook の状態。 */
export type DiscordWebhookTeraView = {
  teraId: string;
  /** 画面に出す Tera の名前。 */
  teraName: string;
  /** webhook URL が保存されているか。 */
  connected: boolean;
  /** Discord 側で付けた webhook の名前。分からなければ null。 */
  webhookName: string | null;
  /** 送信先のチャンネル ID。分からなければ null。 */
  channelId: string | null;
  /** 保存した値を読めなかった理由。無ければ null。 */
  detail: string | null;
};

/** Discord の webhook の設定。設定を変える API はすべてこの形を返す。 */
export type DiscordWebhooksView = {
  /** webhook の作り方を説明するページ。 */
  setupUrl: string;
  /** Tera ごとの状態。並び順は Tera の一覧と同じ。 */
  teras: DiscordWebhookTeraView[];
};

import { signal } from "@preact/signals";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";

/**
 * 設定 > 接続 の Discord（Tera ごとの webhook）の状態。
 *
 * webhook URL は秘密なので、画面には戻さない（webhook の名前とチャンネル ID だけ）。
 * 保存したら一覧を置き換える。チャットのカードの待ちは、サーバーが保存で解く。
 */

/** 貼り付け欄に出す、webhook URL の例。 */
export const WEBHOOK_PLACEHOLDER = "https://discord.com/api/webhooks/…";

/** サーバーから読んだ一覧。まだ読めていないときは null。 */
const resource = createResource(api.fetchDiscord);
export const discord = resource.data;
export const isLoadingDiscord = resource.loading;

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const discordError = failure.error;
export const showDiscordError = failure.show;
export const clearDiscordError = failure.clear;

/** URL を保存している Tera。操作中の表示に使う。 */
export const savingDiscord = signal<string | null>(null);

/** 設定画面を開いたときに読む（まだ読めていなければ）。 */
export const loadDiscord = resource.load;
/** 一覧を読み直す。 */
export const refreshDiscord = resource.refresh;

/** webhook URL を保存する。受け付けられなければ、サーバーが理由を返す。 */
export async function saveWebhook(teraId: string, url: string): Promise<void> {
  savingDiscord.value = teraId;
  try {
    discord.value = await api.saveDiscordWebhook(teraId, url.trim());
  } finally {
    if (savingDiscord.value === teraId) savingDiscord.value = null;
  }
}

/** 保存されている webhook を消す。 */
export async function removeWebhook(teraId: string): Promise<void> {
  discord.value = await api.clearDiscordWebhook(teraId);
}

/** チャットのカードから、接続の待ちをやめる。 */
export async function cancelDiscordWait(teraId: string): Promise<void> {
  discord.value = await api.cancelDiscordWait(teraId);
}

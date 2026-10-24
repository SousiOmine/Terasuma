import { signal } from "@preact/signals";
import * as api from "../lib/api";
import { createErrorSignal } from "../lib/errors";
import { createResource } from "./resource";

/**
 * 設定 > コネクタ の Discord（Tera ごとの webhook）の状態。
 *
 * webhook URL は秘密なので、画面には戻さない（webhook の名前とチャンネル ID だけ）。
 * 保存したら一覧を置き換える。チャットのカードの待ちは、サーバーが保存で解く。
 * 設定画面では Tera ごとの欄をまとめて保存する。
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

/** URL を保存している最中か。まとめて保存するので、どの Tera かは持たない。 */
export const savingDiscord = signal(false);

/** 設定画面を開いたときに読む（まだ読めていなければ）。 */
export const loadDiscord = resource.load;
/** 一覧を読み直す。 */

/** 入力された URL をまとめて保存する。1 つ失敗しても残りは試し、失敗した分をまとめて投げる。 */
export async function saveWebhooks(entries: readonly { teraId: string; url: string }[]): Promise<void> {
  savingDiscord.value = true;
  const failed: string[] = [];
  try {
    for (const entry of entries) {
      try {
        discord.value = await api.saveDiscordWebhook(entry.teraId, entry.url.trim());
      } catch (error) {
        const name = discord.value?.teras.find((tera) => tera.teraId === entry.teraId)?.teraName ?? entry.teraId;
        failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    savingDiscord.value = false;
  }

  if (failed.length > 0) throw new Error(failed.join(" / "));
}

/** 保存されている webhook を消す。 */
export async function removeWebhook(teraId: string): Promise<void> {
  discord.value = await api.clearDiscordWebhook(teraId);
}

/** チャットのカードから、Discord の webhook の待ちをやめる。 */
export async function cancelDiscordWait(teraId: string): Promise<void> {
  discord.value = await api.cancelDiscordWait(teraId);
}

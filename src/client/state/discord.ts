import { signal } from "@preact/signals";
import * as api from "../lib/api";
import { describeError } from "../../shared/errors";
import { createErrorSignal } from "../lib/errors";
import { ApiError } from "../lib/http";
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
export const discordResource = createResource(api.fetchDiscord);
export const discord = discordResource.data;
export const isLoadingDiscord = discordResource.loading;
/** 一覧を読めなかった理由。「読み込み中」と区別して画面に出す。 */
export const discordLoadError = discordResource.error;

/** 設定画面の中だけに出す失敗。 */
const failure = createErrorSignal();
export const discordError = failure.error;
export const showDiscordError = failure.show;
export const clearDiscordError = failure.clear;

/** URL を保存している最中か。まとめて保存するので、どの Tera かは持たない。 */
export const savingDiscord = signal(false);

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
        failed.push(`${name}: ${describeError(error)}`);
      }
    }
  } finally {
    savingDiscord.value = false;
  }

  // どの Tera の保存に失敗したかは、名前に添えて 1 つの失敗として返す。
  // 失敗の種別（コード）は画面が文言を選べるように、1 つ目の失敗から引き継ぐ。
  if (failed.length > 0) throw new ApiError("invalid_request", failed.join(", "));
}

/** 保存されている webhook を消す。 */
export async function removeWebhook(teraId: string): Promise<void> {
  discord.value = await api.clearDiscordWebhook(teraId);
}

/** チャットのカードから、Discord の webhook の待ちをやめる。 */
export async function cancelDiscordWait(teraId: string): Promise<void> {
  discord.value = await api.cancelDiscordWait(teraId);
}

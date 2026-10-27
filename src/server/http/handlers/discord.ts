import { asValidationError } from "../../errors";
import { readDiscordWebhookForm } from "../body";
import { json } from "../respond";
import { requireTera, type ApiDeps, type ApiRequest } from "./shared";

/**
 * Discord の webhook の設定。
 *
 * 送信先の webhook は Tera ごとに 1 つ。URL そのものは返さず、確かめたときに分かった
 * webhook の名前とチャンネル ID だけを返す。
 * 保存する前に GET で webhook を確かめる（受け付けられない URL は保存しない）。
 * チャットのカードが待ちをやめるときだけ、wait を止める。
 */
export function discordHandlers(deps: Pick<ApiDeps, "store" | "discord">) {
  const { store, discord } = deps;

  return {
    /** Tera ごとの webhook の状態。 */
    readDiscord(): Response {
      return json(discord.view());
    },

    /** webhook URL を保存する。保存する前に、その URL の webhook を確かめる。 */
    async setDiscordWebhook(req: ApiRequest<{ teraId: string }>): Promise<Response> {
      const teraId = req.params.teraId;
      requireTera(store, teraId);

      const form = await readDiscordWebhookForm(req);
      try {
        return json(await discord.set(teraId, form.url));
      } catch (error) {
        // 受け付けられない URL・Discord に届かない、は入力の誤りとして返す。
        asValidationError(error);
      }
    },

    /** 保存されている webhook を消す。 */
    clearDiscordWebhook(req: ApiRequest<{ teraId: string }>): Response {
      const teraId = req.params.teraId;
      requireTera(store, teraId);

      return json(discord.clear(teraId));
    },

    /** チャットのカードが、URL の保存待ちをやめる。 */
    cancelDiscordWait(req: ApiRequest<{ teraId: string }>): Response {
      const teraId = req.params.teraId;
      requireTera(store, teraId);

      discord.cancelWait(teraId);
      return json(discord.view());
    },
  };
}

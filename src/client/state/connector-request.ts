import { computed, signal } from "@preact/signals";
import type { ConnectorProviderView } from "../../shared/api/settings";
import { DISCORD_SERVER_ID } from "../../shared/tools";
import { t } from "../i18n";
import { ApiError } from "../lib/http";
import {
  cancelConnectorWait,
  connectConnector,
  connecting,
  connectors,
  saveConnectorToken,
  savingToken,
} from "./connectors";
import { cancelDiscordWait, discord, saveWebhooks, savingDiscord, WEBHOOK_PLACEHOLDER } from "./discord";

/**
 * チャットのコネクタカード。
 *
 * エージェントが app_connect_<id>（GitHub など）か discord_connect（Discord）を呼んだときに始まり、
 * 値の保存が終わるまで続く。値はサーバーへ直接送り、モデルの文脈には載らない。
 * Discord の送信先は Tera ごとに 1 つなので、カードを出した時点の Tera を覚えておく。
 */

export type ConnectorRequestPhase =
  /** 値の入力を待っている。 */
  | "waiting"
  /** 接続できなかった。 */
  | "failed";

export type ConnectorRequest = {
  /** カードを出したツール呼び出しの id。結果と突き合わせる。 */
  callId: string;
  /** 接続するアプリの id（"github" か "discord"）。 */
  provider: string;
  /** モデルが書いた理由。無ければ null。 */
  reason: string | null;
  /** Discord の webhook を保存する先の Tera。GitHub では null。 */
  teraId: string | null;
  phase: ConnectorRequestPhase;
};

export const connectorRequest = signal<ConnectorRequest | null>(null);

/** いまカードを出しているツール呼び出しの id。出していなければ null。 */
let requestCallId: string | null = null;

/** カードを出す。 */
export function beginConnectorRequest(
  callId: string,
  provider: string,
  reason: string | null,
  teraId: string | null,
): void {
  requestCallId = callId;
  connectorRequest.value = { callId, provider, reason, teraId, phase: "waiting" };
}

/**
 * 結果が届いたら終える。
 * 成功ではカードを畳み、失敗では残す（もう一度試す導線を消さない）。
 */
export function endConnectorRequest(callId: string, failed: boolean): void {
  if (requestCallId !== callId) return;

  if (!failed) {
    resetConnectorRequest();
    return;
  }

  const request = connectorRequest.value;
  if (request === null) return;
  connectorRequest.value = { ...request, phase: "failed" };
}

/** カードを畳む。ターンの終了・Tera の切り替え・閉じるで呼ぶ。 */
export function resetConnectorRequest(): void {
  requestCallId = null;
  connectorRequest.value = null;
}

/** カードに出す、貼り付け欄か設定欄の見た目。 */
export type ConnectorRequestField =
  | { kind: "token"; label: string; description: string; placeholder: string; setupUrl: string | null }
  | { kind: "program"; setup: NonNullable<ConnectorProviderView["setup"]>; setupUrl: string | null };

/** カードの入力欄。アプリが分かるまでは null（読み込み中）。 */
export const connectorRequestField = computed<ConnectorRequestField | null>(() => {
  const request = connectorRequest.value;
  if (request === null) return null;

  if (request.provider === DISCORD_SERVER_ID) {
    return {
      kind: "token",
      label: t("settings.discord.field.label"),
      description: t("settings.discord.field.description"),
      placeholder: WEBHOOK_PLACEHOLDER,
      setupUrl: discord.value?.setupUrl ?? null,
    };
  }

  const provider = connectors.value?.providers.find((entry) => entry.id === request.provider) ?? null;
  if (provider === null) return null;

  if (provider.kind === "program") {
    if (provider.setup === null) return null;
    return { kind: "program", setup: provider.setup, setupUrl: provider.setupUrl };
  }

  if (provider.token === null) return null;

  return {
    kind: "token",
    label: provider.token.label,
    description: provider.token.description,
    placeholder: provider.token.placeholder,
    setupUrl: provider.setupUrl,
  };
});

/** いまのカードが、値を保存している最中か。 */
export const savingConnectorRequest = computed<boolean>(() => {
  const request = connectorRequest.value;
  if (request === null) return false;

  if (request.provider === DISCORD_SERVER_ID) {
    return request.teraId !== null && savingDiscord.value;
  }

  const provider = connectors.value?.providers.find((entry) => entry.id === request.provider) ?? null;
  if (provider?.kind === "program") return connecting.value === request.provider;

  return savingToken.value === request.provider;
});

/** カードの値を保存する。サーバーが確かめてから保存する。 */
export async function saveConnectorRequest(value: string): Promise<void> {
  const request = connectorRequest.value;
  if (request === null) return;

  if (request.provider === DISCORD_SERVER_ID) {
    const teraId = request.teraId;
    if (teraId === null) throw new ApiError("tera_unknown");
    if (savingDiscord.value) return;

    await saveWebhooks([{ teraId, url: value }]);
    return;
  }

  if (savingToken.value === request.provider) return;
  await saveConnectorToken(request.provider, value);
}

/** program コネクタの設定を保存して接続する。キーは state に残さない。 */
export async function saveProgramConnector(input: {
  provider: string;
  apiKey?: string;
  model?: string;
}): Promise<void> {
  const request = connectorRequest.value;
  if (request === null) return;
  if (connecting.value === request.provider) return;

  await connectConnector(request.provider, input);
}

/** 接続をやめる。サーバーの待ちも止める。 */
export async function cancelConnectorRequest(): Promise<void> {
  const request = connectorRequest.value;
  if (request === null) return;

  if (request.provider === DISCORD_SERVER_ID) {
    const teraId = request.teraId;
    if (teraId === null || savingDiscord.value) return;

    await cancelDiscordWait(teraId);
    resetConnectorRequest();
    return;
  }

  if (savingToken.value === request.provider) return;

  await cancelConnectorWait(request.provider);
  resetConnectorRequest();
}

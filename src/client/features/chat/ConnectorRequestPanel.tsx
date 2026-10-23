import { IconExternalLink } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { DISCORD_SERVER_ID } from "../../../shared/tools";
import { t } from "../../i18n";
import {
  cancelConnectorRequest,
  connectorRequest,
  connectorRequestField,
  resetConnectorRequest,
  saveConnectorRequest,
  savingConnectorRequest,
} from "../../state/connector-request";
import { connectors, isLoadingConnectors, loadConnectors } from "../../state/connectors";
import { discord, isLoadingDiscord, loadDiscord } from "../../state/discord";
import { showChatError } from "../../state/failure";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { INPUT_CLASS } from "../../ui/styles";

/**
 * コネクタのカード。
 *
 * エージェントが computer_connect_app（GitHub のトークン）か discord_connect（Discord の webhook）を
 * 呼んだとき、チャットの入力欄の上に出る。ユーザーはここで値を貼り付けて保存する。
 * 値はサーバーへ直接送り、モデルの文脈には載らない。
 */
export function ConnectorRequestPanel() {
  const request = connectorRequest.value;
  const field = connectorRequestField.value;
  const saving = savingConnectorRequest.value;
  const [token, setToken] = useState("");

  // 設定画面を開いていなくても、表示名と貼り付け欄の説明を出せるようにする。
  useEffect(() => {
    if (connectors.value === null && !isLoadingConnectors.value) {
      void loadConnectors().catch(showChatError);
    }
    if (discord.value === null && !isLoadingDiscord.value) {
      void loadDiscord().catch(showChatError);
    }
  }, []);

  // 新しいカードが出たら、入力欄を空に戻す。
  useEffect(() => {
    setToken("");
  }, [request?.callId]);

  if (request === null) return null;

  const app = appNameOf(request.provider);

  const save = (): void => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;

    void saveConnectorRequest(trimmed)
      .then(() => setToken(""))
      .catch(showChatError);
  };

  const cancel = (): void => {
    void cancelConnectorRequest().catch(showChatError);
  };

  return (
    <section class="tera-rise-in rounded-[20px] border border-stroke bg-surface-alt p-4">
      <p class="text-[13px] font-medium">{t("chat.connector.title", { app })}</p>
      {request.reason !== null && (
        <p class="mt-1 whitespace-pre-wrap text-xs leading-5 text-secondary">{request.reason}</p>
      )}

      {request.phase === "failed" ? (
        <>
          <p class="mt-3 text-xs leading-5 text-secondary">{t("chat.connector.failed")}</p>
          <div class="mt-3 flex justify-end">
            <button
              type="button"
              onClick={resetConnectorRequest}
              class="shrink-0 text-[11px] font-medium text-secondary underline-offset-2 transition hover:text-primary hover:underline"
            >
              {t("common.cancel")}
            </button>
          </div>
        </>
      ) : field === null ? (
        <p class="mt-3 text-xs text-secondary">{t("common.loading")}</p>
      ) : (
        <>
          <Field label={field.label} description={field.description}>
            <div class="flex items-center gap-2">
              <input
                class={`${INPUT_CLASS} min-w-0 flex-1`}
                type="password"
                value={token}
                placeholder={field.placeholder}
                aria-label={field.label}
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                disabled={saving}
                onInput={(event) => setToken(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  save();
                }}
              />
              <Button variant="primary" disabled={saving || token.trim().length === 0} onClick={save}>
                {t(saving ? "settings.connectors.token.saving" : "settings.connectors.token.save")}
              </Button>
            </div>
          </Field>

          <div class="flex flex-wrap items-center gap-3">
            {field.setupUrl !== null && (
              <a
                href={field.setupUrl}
                target="_blank"
                rel="noreferrer noopener"
                class="inline-flex items-center gap-1 text-xs text-secondary underline underline-offset-2"
              >
                <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
                {t(request.provider === DISCORD_SERVER_ID ? "settings.discord.setup" : "settings.connectors.openSetup")}
              </a>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={cancel}
              class="shrink-0 text-[11px] font-medium text-secondary underline-offset-2 transition hover:text-primary hover:underline disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
          </div>

          <p class="mt-2 text-[11px] leading-5 text-secondary">{t("chat.connector.waiting")}</p>
        </>
      )}
    </section>
  );
}

/** カードの見出しに出すアプリの名前。Discord はコネクタの一覧に無いので、ここで決める。 */
function appNameOf(provider: string): string {
  if (provider === DISCORD_SERVER_ID) return "Discord";

  return connectors.value?.providers.find((entry) => entry.id === provider)?.name ?? provider;
}

import { IconExternalLink } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n";
import {
  cancelConnectionRequest,
  connectionRequest,
  connectionRequestSaving,
  resetConnectionRequest,
  saveConnectionRequestToken,
} from "../../state/connection-request";
import { connections, isLoadingConnections, loadConnections } from "../../state/connections";
import { showChatError } from "../../state/failure";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { INPUT_CLASS } from "../../ui/styles";

/**
 * アプリの接続カード。
 *
 * エージェントが computer_connect_app を呼んだとき、チャットの入力欄の上に出る。
 * ユーザーはここでトークンを貼り付けて保存する。トークンはサーバーへ直接送り、
 * モデルの文脈には載らない（コンピュータの環境変数と、サーバー側の app_request だけが使う）。
 */
export function ConnectionRequestPanel() {
  const request = connectionRequest.value;
  const saving = connectionRequestSaving.value;
  const view = connections.value;
  const [token, setToken] = useState("");

  // 設定画面を開いていなくても、表示名とトークン欄の説明を出せるようにする。
  useEffect(() => {
    if (connections.value !== null || isLoadingConnections.value) return;
    void loadConnections().catch(showChatError);
  }, []);

  // 新しいカードが出たら、入力欄を空に戻す。
  useEffect(() => {
    setToken("");
  }, [request?.callId]);

  if (request === null) return null;

  const provider = view?.providers.find((entry) => entry.id === request.provider) ?? null;
  const app = provider?.name ?? request.provider;

  const save = (): void => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;

    void saveConnectionRequestToken(trimmed)
      .then(() => setToken(""))
      .catch(showChatError);
  };

  const cancel = (): void => {
    void cancelConnectionRequest().catch(showChatError);
  };

  return (
    <section class="rounded-[20px] border border-[var(--app-stroke)] bg-[var(--app-surface-alt)] p-4">
      <p class="text-[13px] font-medium">{t("chat.connection.title", { app })}</p>
      {request.reason !== null && (
        <p class="mt-1 whitespace-pre-wrap text-xs leading-5 text-[var(--app-text-secondary)]">{request.reason}</p>
      )}

      {request.phase === "failed" ? (
        <>
          <p class="mt-3 text-xs leading-5 text-[var(--app-text-secondary)]">{t("chat.connection.failed")}</p>
          <div class="mt-3 flex justify-end">
            <button
              type="button"
              onClick={resetConnectionRequest}
              class="shrink-0 text-[11px] font-medium text-[var(--app-text-secondary)] underline-offset-2 transition hover:text-[var(--app-text)] hover:underline"
            >
              {t("common.cancel")}
            </button>
          </div>
        </>
      ) : provider === null ? (
        <p class="mt-3 text-xs text-[var(--app-text-secondary)]">{t("common.loading")}</p>
      ) : (
        <>
          <Field label={provider.token.label} description={provider.token.description}>
            <div class="flex items-center gap-2">
              <input
                class={`${INPUT_CLASS} min-w-0 flex-1`}
                type="password"
                value={token}
                placeholder={provider.token.placeholder}
                aria-label={provider.token.label}
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
                {t(saving ? "settings.connections.token.saving" : "settings.connections.token.save")}
              </Button>
            </div>
          </Field>

          <div class="flex flex-wrap items-center gap-3">
            <a
              href={provider.setupUrl}
              target="_blank"
              rel="noreferrer noopener"
              class="inline-flex items-center gap-1 text-xs text-[var(--app-text-secondary)] underline underline-offset-2"
            >
              <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
              {t("settings.connections.openSetup")}
            </a>
            <button
              type="button"
              disabled={saving}
              onClick={cancel}
              class="shrink-0 text-[11px] font-medium text-[var(--app-text-secondary)] underline-offset-2 transition hover:text-[var(--app-text)] hover:underline disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
          </div>

          <p class="mt-2 text-[11px] leading-5 text-[var(--app-text-secondary)]">{t("chat.connection.waiting")}</p>
        </>
      )}
    </section>
  );
}

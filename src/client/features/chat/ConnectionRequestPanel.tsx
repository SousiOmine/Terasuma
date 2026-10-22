import { IconExternalLink } from "@tabler/icons-preact";
import { useEffect } from "preact/hooks";
import { t } from "../../i18n";
import {
  cancelConnectionRequest,
  connectionRequest,
  connectionRequestSending,
  resetConnectionRequest,
  startConnectionRequestFlow,
} from "../../state/connection-request";
import { openSettings } from "../../state/route";
import { CopyCode } from "../../ui/CopyCode";

/**
 * アプリの認証カード。
 *
 * エージェントが computer_connect_app を呼んだとき、チャットの入力欄の上に出る。
 * コードはユーザーが認可ページへ入力し、終わるまでサーバーがトークンを待つ。
 * トークンはこの画面を通らない（コンピュータの環境変数と、サーバー側の app_request だけが使う）。
 */
export function ConnectionRequestPanel() {
  const request = connectionRequest.value;
  const sending = connectionRequestSending.value;
  const callId = request?.callId;

  // 新しいカードが出たら、サーバーに認可のコードを作ってもらう。
  useEffect(() => {
    if (callId === undefined) return;
    void startConnectionRequestFlow();
  }, [callId]);

  if (request === null) return null;

  const app = request.providerName ?? request.provider;
  const flow = request.flow;

  return (
    <section class="rounded-[20px] border border-[var(--app-stroke)] bg-[var(--app-surface-alt)] p-4">
      <p class="text-[13px] font-medium">{t("chat.connection.title", { app })}</p>
      {request.reason !== null && (
        <p class="mt-1 whitespace-pre-wrap text-xs leading-5 text-[var(--app-text-secondary)]">{request.reason}</p>
      )}

      {request.phase === "setup_required" ? (
        <>
          <p class="mt-3 text-xs leading-5 text-[var(--app-text-secondary)]">{t("chat.connection.setup")}</p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openSettings("connections")}
              class="inline-flex items-center justify-center rounded-full bg-[var(--app-accent-fill)] px-4 py-2 text-xs font-medium whitespace-nowrap text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)] transition hover:bg-[var(--app-accent-hover)]"
            >
              {t("chat.connection.openSettings")}
            </button>
            <button
              type="button"
              onClick={resetConnectionRequest}
              class="shrink-0 text-[11px] font-medium text-[var(--app-text-secondary)] underline-offset-2 transition hover:text-[var(--app-text)] hover:underline"
            >
              {t("common.cancel")}
            </button>
          </div>
        </>
      ) : request.phase === "failed" ? (
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
      ) : flow === null ? (
        <p class="mt-3 text-xs text-[var(--app-text-secondary)]">{t("chat.connection.starting")}</p>
      ) : (
        <>
          <p class="mt-3 text-xs text-[var(--app-text-secondary)]">{t("chat.connection.code")}</p>
          <div class="mt-1">
            <CopyCode code={flow.userCode} />
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <a
              href={flow.verificationUri}
              target="_blank"
              rel="noreferrer noopener"
              class="inline-flex items-center gap-1.5 rounded-full bg-[var(--app-accent-fill)] px-4 py-2 text-xs font-medium whitespace-nowrap text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)] transition hover:bg-[var(--app-accent-hover)]"
            >
              <IconExternalLink size={13} stroke={1.7} class="shrink-0" />
              {t("chat.connection.open", { app })}
            </a>
            <button
              type="button"
              disabled={sending}
              onClick={() => void cancelConnectionRequest()}
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

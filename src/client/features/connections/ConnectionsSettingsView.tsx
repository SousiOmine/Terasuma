import { IconExternalLink } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import type { ConnectionProviderView } from "../../../shared/types";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import type { MessageKey } from "../../i18n";
import { t } from "../../i18n";
import {
  authorizingConnection,
  cancelConnectionAuthorization,
  clearConnectionsError,
  connectionFlow,
  connections,
  connectionsError,
  isLoadingConnections,
  loadConnections,
  removeConnection,
  saveClientId,
  savingConnection,
  showConnectionsError,
  startConnectionAuthorization,
} from "../../state/connections";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { CopyCode } from "../../ui/CopyCode";
import { Field } from "../../ui/Field";
import { SettingsSection } from "../../ui/SettingsSection";
import { StatusBadge } from "../../ui/StatusBadge";
import { CARD_ACTION_CLASS, CARD_CLASS, INPUT_CLASS } from "../../ui/styles";

/** 接続状態の文言。i18n のキーは文字列リテラルで持つ（未使用キーの検査に載せるため）。 */
const STATE_LABELS: Record<"connected" | "authorizing" | "disconnected", MessageKey> = {
  connected: "settings.connections.state.connected",
  authorizing: "settings.connections.state.authorizing",
  disconnected: "settings.connections.state.disconnected",
};

/**
 * 設定 > 接続。
 *
 * Client ID を保存し、アプリのアカウントでサインインする。
 * 認可はブラウザの別タブで進むので、コードを出したあとは一覧を読み直して完了を待つ。
 */
export function ConnectionsSettingsView() {
  const view = connections.value;
  const error = connectionsError.value;
  const disconnecting = useDeleteTarget<ConnectionProviderView>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (connections.value !== null || isLoadingConnections.value) return;
    void loadConnections().catch(showConnectionsError);
  }, []);

  return (
    <SettingsSection title={t("settings.connections")} error={error} onDismiss={clearConnectionsError}>
      <p class="mt-2 text-xs leading-5 text-[var(--app-text-secondary)]">{t("settings.connections.description")}</p>

      <div class="mt-4 space-y-2">
        {view === null ? (
          <p class="text-xs text-[var(--app-text-secondary)]">{t("common.loading")}</p>
        ) : (
          view.providers.map((provider) => (
            <ConnectionCard key={provider.id} provider={provider} onDisconnect={() => disconnecting.open(provider)} />
          ))
        )}
      </div>

      {disconnecting.target !== null && (
        <ConfirmDialog
          title={t("settings.connections.disconnectTitle")}
          subject={disconnecting.target.name}
          message={t("settings.connections.disconnectMessage")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => disconnecting.confirm(removeConnection, showConnectionsError)}
          onCancel={disconnecting.close}
        />
      )}
    </SettingsSection>
  );
}

type ConnectionCardProps = {
  provider: ConnectionProviderView;
  onDisconnect: () => void;
};

function ConnectionCard({ provider, onDisconnect }: ConnectionCardProps) {
  const saving = savingConnection.value === provider.id;
  const authorizing = authorizingConnection.value === provider.id;
  // 認可のコードはサーバーの一覧にも載るので、画面を開き直しても出せる。
  const flow = provider.flow ?? (authorizing ? connectionFlow.value : null);

  const [clientId, setClientId] = useState(provider.clientId ?? "");

  // 保存された値が変わったら、入力欄もその値に戻す。
  useEffect(() => {
    setClientId(provider.clientId ?? "");
  }, [provider.clientId]);

  const save = (): void => {
    void saveClientId(provider.id, clientId).catch(showConnectionsError);
  };

  const authorize = (): void => {
    void startConnectionAuthorization(provider.id).catch(showConnectionsError);
  };

  const cancel = (): void => {
    void cancelConnectionAuthorization(provider.id).catch(showConnectionsError);
  };

  const connected = provider.account !== null;
  const state: "connected" | "authorizing" | "disconnected" = flow !== null
    ? "authorizing"
    : connected
      ? "connected"
      : "disconnected";

  return (
    <div class={CARD_CLASS}>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <p class="truncate text-sm font-medium">{provider.name}</p>
            <StatusBadge tone={state === "connected" ? "success" : state === "authorizing" ? "info" : "neutral"}>
              {t(STATE_LABELS[state])}
            </StatusBadge>
            {connected && (
              <span class="text-xs text-[var(--app-text-secondary)]">
                {t("settings.connections.account", { account: `@${provider.account ?? ""}` })}
              </span>
            )}
          </div>

          <p class="mt-1 text-xs leading-5 text-[var(--app-text-secondary)]">{provider.description}</p>
          <p class="mt-1 text-[11px] leading-5 text-[var(--app-text-secondary)]">
            {t("settings.connections.scopes", { scopes: provider.scopes.join(", ") })}
          </p>
          {provider.detail !== null && (
            <p class="mt-1.5 break-words text-xs leading-5 text-[var(--app-text-secondary)]">{provider.detail}</p>
          )}
        </div>

        {connected && (
          <button type="button" onClick={onDisconnect} class={CARD_ACTION_CLASS}>
            {t("settings.connections.disconnect")}
          </button>
        )}
      </div>

      {flow !== null ? (
        <div class="mt-4">
          <p class="text-xs text-[var(--app-text-secondary)]">{t("settings.connections.code")}</p>
          <div class="mt-1">
            <CopyCode code={flow.userCode} />
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-3">
            <a
              href={flow.verificationUri}
              target="_blank"
              rel="noreferrer noopener"
              class="inline-flex items-center gap-1 text-xs underline underline-offset-2"
            >
              <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
              {t("settings.connections.openAuthorization")}
            </a>
            <button
              type="button"
              onClick={cancel}
              class="shrink-0 text-[11px] font-medium text-[var(--app-text-secondary)] underline-offset-2 transition hover:text-[var(--app-text)] hover:underline"
            >
              {t("settings.connections.cancelAuthorize")}
            </button>
          </div>
          <p class="mt-2 text-[11px] leading-5 text-[var(--app-text-secondary)]">
            {t("settings.connections.waiting")}
          </p>
        </div>
      ) : connected ? (
        <p class="mt-3 text-[11px] leading-5 text-[var(--app-text-secondary)]">
          {t("settings.connections.env", { names: provider.env.join(", ") })}
        </p>
      ) : (
        <form
          class="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field
            label={t("settings.connections.clientId.label")}
            description={t("settings.connections.clientId.description")}
          >
            <div class="flex items-center gap-2">
              <input
                class={`${INPUT_CLASS} min-w-0 flex-1`}
                value={clientId}
                placeholder={t("settings.connections.clientId.placeholder")}
                aria-label={t("settings.connections.clientId.label")}
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                disabled={saving}
                onInput={(event) => setClientId(event.currentTarget.value)}
              />
              <Button disabled={saving} onClick={save}>
                {t(saving ? "settings.connections.clientId.saving" : "settings.connections.clientId.save")}
              </Button>
            </div>
          </Field>

          <div class="flex flex-col gap-3 border-t border-[var(--app-stroke)] pt-3 sm:flex-row sm:items-center sm:justify-between">
            <a
              href={provider.setupUrl}
              target="_blank"
              rel="noreferrer noopener"
              class="inline-flex items-center gap-1 text-xs text-[var(--app-text-secondary)] underline underline-offset-2"
            >
              <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
              {t("settings.connections.openSetup")}
            </a>
            <Button variant="primary" disabled={provider.clientId === null || saving} onClick={authorize}>
              {t("settings.connections.authorize")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

import { IconExternalLink } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import type { ConnectionFlowView, ConnectionProviderView } from "../../../shared/types";
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
  saveBotToken,
  saveClientId,
  savingBotToken,
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
 * GitHub は Client ID を保存して、アプリのアカウントでサインインする。
 * Discord は Bot トークンを貼る（OAuth の同意画面ではトークンが取れないため）。
 * どちらも、接続するとコンピュータの環境変数と app_request が使えるようになる。
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
  const savingToken = savingBotToken.value === provider.id;
  const authorizing = authorizingConnection.value === provider.id;
  // 認可のコードはサーバーの一覧にも載るので、画面を開き直しても出せる。
  const flow = provider.flow ?? (authorizing ? connectionFlow.value : null);
  const connected = provider.connected;
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
            {connected && provider.account !== null && (
              <span class="text-xs text-[var(--app-text-secondary)]">
                {t("settings.connections.account", { account: `@${provider.account}` })}
              </span>
            )}
          </div>

          <p class="mt-1 text-xs leading-5 text-[var(--app-text-secondary)]">{provider.description}</p>
          <p class="mt-1 text-[11px] leading-5 text-[var(--app-text-secondary)]">
            {t("settings.connections.permissions", { permissions: provider.permissions.join(", ") })}
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

      {provider.kind === "bot" ? (
        <BotConnectionForm provider={provider} savingToken={savingToken} />
      ) : flow !== null ? (
        <DeviceAuthorization provider={provider} flow={flow} />
      ) : (
        <DeviceConnectionForm provider={provider} saving={saving} />
      )}

      {connected && (
        <p class="mt-3 text-[11px] leading-5 text-[var(--app-text-secondary)]">
          {t("settings.connections.env", { names: provider.env.join(", ") })}
        </p>
      )}
    </div>
  );
}

/** Device Flow の認可コード。承認が終わるまで、この画面に出す。 */
function DeviceAuthorization({ provider, flow }: { provider: ConnectionProviderView; flow: ConnectionFlowView }) {
  const cancel = (): void => {
    void cancelConnectionAuthorization(provider.id).catch(showConnectionsError);
  };

  return (
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
  );
}

/** Device Flow の Client ID 入力と、認可を始めるボタン。 */
function DeviceConnectionForm({ provider, saving }: { provider: ConnectionProviderView; saving: boolean }) {
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

  return (
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
  );
}

/**
 * Bot トークンの入力。
 *
 * Application ID はサーバーへ追加するリンクに、トークンは API の呼び出しに使う。
 * トークンは保存後に返らないので、入力欄は毎回空から始める。
 */
function BotConnectionForm({ provider, savingToken }: { provider: ConnectionProviderView; savingToken: boolean }) {
  const savingClientId = savingConnection.value === provider.id;
  const [clientId, setClientId] = useState(provider.clientId ?? "");
  const [token, setToken] = useState("");

  useEffect(() => {
    setClientId(provider.clientId ?? "");
  }, [provider.clientId]);

  const saveApplicationId = (): void => {
    void saveClientId(provider.id, clientId).catch(showConnectionsError);
  };

  const saveToken = (): void => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;

    void saveBotToken(provider.id, trimmed)
      .then(() => setToken(""))
      .catch(showConnectionsError);
  };

  return (
    <div class="mt-3">
      <Field
        label={t("settings.connections.applicationId.label")}
        description={t("settings.connections.applicationId.description")}
      >
        <div class="flex items-center gap-2">
          <input
            class={`${INPUT_CLASS} min-w-0 flex-1`}
            value={clientId}
            placeholder={t("settings.connections.applicationId.placeholder")}
            aria-label={t("settings.connections.applicationId.label")}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            disabled={savingClientId}
            onInput={(event) => setClientId(event.currentTarget.value)}
          />
          <Button disabled={savingClientId} onClick={saveApplicationId}>
            {t(savingClientId ? "settings.connections.clientId.saving" : "settings.connections.clientId.save")}
          </Button>
        </div>
      </Field>

      <Field
        label={t("settings.connections.botToken.label")}
        description={t("settings.connections.botToken.description")}
      >
        <div class="flex items-center gap-2">
          <input
            class={`${INPUT_CLASS} min-w-0 flex-1`}
            type="password"
            value={token}
            placeholder={t("settings.connections.botToken.placeholder")}
            aria-label={t("settings.connections.botToken.label")}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            disabled={savingToken}
            onInput={(event) => setToken(event.currentTarget.value)}
          />
          <Button variant="primary" disabled={savingToken || token.trim().length === 0} onClick={saveToken}>
            {t(savingToken ? "settings.connections.botToken.saving" : "settings.connections.botToken.save")}
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
        {provider.inviteUrl !== null ? (
          <a
            href={provider.inviteUrl}
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--app-soft)] px-4 py-2 text-xs font-medium whitespace-nowrap text-[var(--app-text)] transition hover:bg-[var(--app-soft-strong)]"
          >
            <IconExternalLink size={13} stroke={1.7} class="shrink-0" />
            {t("settings.connections.invite")}
          </a>
        ) : (
          <span class="text-[11px] leading-5 text-[var(--app-text-secondary)]">
            {t("settings.connections.inviteNeedsId")}
          </span>
        )}
      </div>

      {provider.connected && (
        <p class="mt-2 text-[11px] leading-5 text-[var(--app-text-secondary)]">
          {t("settings.connections.botToken.saved")}
        </p>
      )}
    </div>
  );
}

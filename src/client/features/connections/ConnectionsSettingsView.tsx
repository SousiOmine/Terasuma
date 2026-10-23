import { IconExternalLink } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import type { ConnectionProviderView } from "../../../shared/api/settings";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import type { MessageKey } from "../../i18n";
import { t } from "../../i18n";
import {
  clearConnectionsError,
  connections,
  connectionsError,
  isLoadingConnections,
  loadConnections,
  removeConnection,
  saveClientId,
  saveConnectionToken,
  savingConnection,
  savingToken,
  showConnectionsError,
} from "../../state/connections";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { SettingsSection } from "../../ui/SettingsSection";
import { StatusBadge } from "../../ui/StatusBadge";
import { CARD_ACTION_CLASS, CARD_CLASS, INPUT_CLASS } from "../../ui/styles";

/** 接続状態の文言。i18n のキーは文字列リテラルで持つ（未使用キーの検査に載せるため）。 */
const STATE_LABELS: Record<"connected" | "disconnected", MessageKey> = {
  connected: "settings.connections.state.connected",
  disconnected: "settings.connections.state.disconnected",
};

/**
 * 設定 > 接続。
 *
 * サービスごとにトークンを発行し、貼り付けて保存する。
 * GitHub は Personal Access Token、Discord は Bot トークン。
 * 保存すると、コンピュータの環境変数と app_request が使えるようになる。
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
      <p class="mt-2 text-xs leading-5 text-secondary">{t("settings.connections.description")}</p>

      <div class="mt-4 space-y-2">
        {view === null ? (
          <p class="text-xs text-secondary">{t("common.loading")}</p>
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
  const savingTokenNow = savingToken.value === provider.id;
  const savingClientId = savingConnection.value === provider.id;

  return (
    <div class={CARD_CLASS}>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <p class="truncate text-sm font-medium">{provider.name}</p>
            <StatusBadge tone={provider.connected ? "success" : "neutral"}>
              {t(provider.connected ? STATE_LABELS.connected : STATE_LABELS.disconnected)}
            </StatusBadge>
            {provider.connected && provider.account !== null && (
              <span class="text-xs text-secondary">
                {t("settings.connections.account", { account: `@${provider.account}` })}
              </span>
            )}
          </div>

          <p class="mt-1 text-xs leading-5 text-secondary">{provider.description}</p>
          <p class="mt-1 text-[11px] leading-5 text-secondary">
            {t("settings.connections.permissions", { permissions: provider.permissions.join(", ") })}
          </p>
          {provider.detail !== null && (
            <p class="mt-1.5 break-words text-xs leading-5 text-secondary">{provider.detail}</p>
          )}
        </div>

        {provider.connected && (
          <button type="button" onClick={onDisconnect} class={CARD_ACTION_CLASS}>
            {t("settings.connections.disconnect")}
          </button>
        )}
      </div>

      <TokenConnectionForm provider={provider} saving={savingTokenNow} />

      {provider.needsClientId && <ApplicationIdForm provider={provider} saving={savingClientId} />}

      {provider.connected && (
        <p class="mt-3 text-[11px] leading-5 text-secondary">
          {t("settings.connections.env", { names: provider.env.join(", ") })}
        </p>
      )}
    </div>
  );
}

/** トークンの入力と保存。保存する前に、サーバーがトークンでアカウントを確かめる。 */
function TokenConnectionForm({ provider, saving }: { provider: ConnectionProviderView; saving: boolean }) {
  const [token, setToken] = useState("");

  const save = (): void => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;

    void saveConnectionToken(provider.id, trimmed)
      .then(() => setToken(""))
      .catch(showConnectionsError);
  };

  return (
    <div class="mt-3">
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

      <div class="flex flex-col gap-3 border-t border-stroke pt-3 sm:flex-row sm:items-center sm:justify-between">
        <a
          href={provider.setupUrl}
          target="_blank"
          rel="noreferrer noopener"
          class="inline-flex items-center gap-1 text-xs text-secondary underline underline-offset-2"
        >
          <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
          {t("settings.connections.openSetup")}
        </a>
        {provider.connected && (
          <p class="text-[11px] leading-5 text-secondary">{t("settings.connections.token.saved")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Application ID の入力（Discord）。
 * 招待リンクに使うだけで、トークンの保存とは独立している。
 */
function ApplicationIdForm({ provider, saving }: { provider: ConnectionProviderView; saving: boolean }) {
  const [clientId, setClientId] = useState(provider.clientId ?? "");

  // 保存された値が変わったら、入力欄もその値に戻す。
  useEffect(() => {
    setClientId(provider.clientId ?? "");
  }, [provider.clientId]);

  const save = (): void => {
    void saveClientId(provider.id, clientId).catch(showConnectionsError);
  };

  return (
    <div class="mt-3 border-t border-stroke pt-3">
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
            disabled={saving}
            onInput={(event) => setClientId(event.currentTarget.value)}
          />
          <Button disabled={saving} onClick={save}>
            {t(saving ? "settings.connections.applicationId.saving" : "settings.connections.applicationId.save")}
          </Button>
        </div>
      </Field>

      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        {provider.inviteUrl !== null ? (
          <a
            href={provider.inviteUrl}
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex items-center justify-center gap-1.5 rounded-full bg-soft px-4 py-2 text-xs font-medium whitespace-nowrap text-primary transition hover:bg-[var(--app-soft-strong)]"
          >
            <IconExternalLink size={13} stroke={1.7} class="shrink-0" />
            {t("settings.connections.invite")}
          </a>
        ) : (
          <span class="text-[11px] leading-5 text-secondary">{t("settings.connections.inviteNeedsId")}</span>
        )}
      </div>
    </div>
  );
}

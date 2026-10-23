import { IconExternalLink } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import type { ConnectorProviderView } from "../../../shared/api/settings";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import type { MessageKey } from "../../i18n";
import { t } from "../../i18n";
import {
  clearConnectorsError,
  connectors,
  connectorsError,
  isLoadingConnectors,
  loadConnectors,
  removeConnector,
  saveConnectorToken,
  savingToken,
  showConnectorsError,
} from "../../state/connectors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { SettingsSection } from "../../ui/SettingsSection";
import { StatusBadge } from "../../ui/StatusBadge";
import { CARD_ACTION_CLASS, CARD_CLASS, INPUT_CLASS } from "../../ui/styles";
import { DiscordWebhooksSection } from "./DiscordWebhooksSection";

/** 接続状態の文言。i18n のキーは文字列リテラルで持つ（未使用キーの検査に載せるため）。 */
const STATE_LABELS: Record<"connected" | "disconnected", MessageKey> = {
  connected: "settings.connectors.state.connected",
  disconnected: "settings.connectors.state.disconnected",
};

/**
 * 設定 > コネクタ。
 *
 * サービスごとにトークンを発行し、貼り付けて保存する。
 * 保存すると、コンピュータの環境変数と app_request が使えるようになる。
 * Discord はトークンではなく webhook を使うので、DiscordWebhooksSection が受け持つ。
 */
export function ConnectorsSettingsView() {
  const view = connectors.value;
  const error = connectorsError.value;
  const disconnecting = useDeleteTarget<ConnectorProviderView>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (connectors.value !== null || isLoadingConnectors.value) return;
    void loadConnectors().catch(showConnectorsError);
  }, []);

  return (
    <SettingsSection title={t("settings.connectors")} error={error} onDismiss={clearConnectorsError}>
      <p class="mt-2 text-xs leading-5 text-secondary">{t("settings.connectors.description")}</p>

      <div class="mt-4 space-y-2">
        {view === null ? (
          <p class="text-xs text-secondary">{t("common.loading")}</p>
        ) : (
          view.providers.map((provider) => (
            <ConnectorCard key={provider.id} provider={provider} onDisconnect={() => disconnecting.open(provider)} />
          ))
        )}
      </div>

      <DiscordWebhooksSection />

      {disconnecting.target !== null && (
        <ConfirmDialog
          title={t("settings.connectors.disconnectTitle")}
          subject={disconnecting.target.name}
          message={t("settings.connectors.disconnectMessage")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => disconnecting.confirm(removeConnector, showConnectorsError)}
          onCancel={disconnecting.close}
        />
      )}
    </SettingsSection>
  );
}

type ConnectorCardProps = {
  provider: ConnectorProviderView;
  onDisconnect: () => void;
};

function ConnectorCard({ provider, onDisconnect }: ConnectorCardProps) {
  const savingTokenNow = savingToken.value === provider.id;

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
                {t("settings.connectors.account", { account: `@${provider.account}` })}
              </span>
            )}
          </div>

          <p class="mt-1 text-xs leading-5 text-secondary">{provider.description}</p>
          <p class="mt-1 text-[11px] leading-5 text-secondary">
            {t("settings.connectors.permissions", { permissions: provider.permissions.join(", ") })}
          </p>
          {provider.detail !== null && (
            <p class="mt-1.5 break-words text-xs leading-5 text-secondary">{provider.detail}</p>
          )}
        </div>

        {provider.connected && (
          <button type="button" onClick={onDisconnect} class={CARD_ACTION_CLASS}>
            {t("settings.connectors.disconnect")}
          </button>
        )}
      </div>

      <TokenConnectorForm provider={provider} saving={savingTokenNow} />

      {provider.connected && (
        <p class="mt-3 text-[11px] leading-5 text-secondary">
          {t("settings.connectors.env", { names: provider.env.join(", ") })}
        </p>
      )}
    </div>
  );
}

/** トークンの入力と保存。保存する前に、サーバーがトークンでアカウントを確かめる。 */
function TokenConnectorForm({ provider, saving }: { provider: ConnectorProviderView; saving: boolean }) {
  const [token, setToken] = useState("");

  const save = (): void => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;

    void saveConnectorToken(provider.id, trimmed)
      .then(() => setToken(""))
      .catch(showConnectorsError);
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
            {t(saving ? "settings.connectors.token.saving" : "settings.connectors.token.save")}
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
          {t("settings.connectors.openSetup")}
        </a>
        {provider.connected && (
          <p class="text-[11px] leading-5 text-secondary">{t("settings.connectors.token.saved")}</p>
        )}
      </div>
    </div>
  );
}

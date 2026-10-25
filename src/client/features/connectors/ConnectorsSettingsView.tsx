import { useEffect, useState } from "preact/hooks";
import type { ConnectorProviderView } from "../../../shared/api/settings";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import type { MessageKey } from "../../i18n";
import { t } from "../../i18n";
import {
  clearConnectorsError,
  connectConnector,
  connecting,
  connectors,
  connectorsError,
  isLoadingConnectors,
  loadConnectors,
  removeConnector,
  saveConnectorToken,
  savingToken,
  showConnectorsError,
} from "../../state/connectors";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { SettingsSection } from "../../ui/SettingsSection";
import { StatusBadge } from "../../ui/StatusBadge";
import { CollapsibleCard } from "../../ui/CollapsibleCard";
import { CARD_ACTION_CLASS, INPUT_CLASS } from "../../ui/styles";
import { ConnectorForm } from "./ConnectorForm";
import { DiscordConnectorCard } from "./DiscordConnectorCard";
import { ProgramSetupForm, type ProgramSetupInput } from "./ProgramSetupForm";

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
 * Discord はトークンではなく webhook を使うので、1 枚のカードで Tera ごとの欄を持つ DiscordConnectorCard が受け持つ。
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
        <DiscordConnectorCard />
      </div>

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

  const lines = [
    provider.description,
    provider.connected && provider.account !== null
      ? t("settings.connectors.account", { account: `@${provider.account}` })
      : null,
    provider.connected && provider.status !== null
      ? t("settings.connectors.program.status", { status: provider.status })
      : null,
    provider.detail,
  ];

  return (
    <CollapsibleCard
      title={provider.name}
      badge={
        <StatusBadge tone={provider.connected ? "success" : "neutral"}>
          {t(provider.connected ? STATE_LABELS.connected : STATE_LABELS.disconnected)}
        </StatusBadge>
      }
      lines={lines}
      action={
        provider.connected ? (
          <button type="button" onClick={onDisconnect} class={CARD_ACTION_CLASS}>
            {t("settings.connectors.disconnect")}
          </button>
        ) : undefined
      }
    >
      {provider.permissions.length > 0 && (
        <p class="text-[11px] leading-5 text-secondary">
          {t("settings.connectors.permissions", { permissions: provider.permissions.join(", ") })}
        </p>
      )}

      {provider.kind === "program" ? (
        <ProgramConnectorForm provider={provider} />
      ) : provider.token !== null ? (
        <TokenConnectorForm provider={provider} field={provider.token} saving={savingTokenNow} />
      ) : null}

      {provider.connected && provider.env.length > 0 && (
        <p class="mt-3 text-[11px] leading-5 text-secondary">
          {t("settings.connectors.env", { names: provider.env.join(", ") })}
        </p>
      )}
    </CollapsibleCard>
  );
}

/** program コネクタの設定。確かめた結果は見出しに出す（CollapsibleCard の lines）。 */
function ProgramConnectorForm({ provider }: { provider: ConnectorProviderView }) {
  const setup = provider.setup;
  if (setup === null) return null;

  const checking = connecting.value === provider.id;

  const submit = (input: ProgramSetupInput): void => {
    void connectConnector(provider.id, input).catch(showConnectorsError);
  };

  return <ProgramSetupForm setup={setup} busy={checking} setupUrl={provider.setupUrl} onSubmit={submit} />;
}

/** トークンの入力と保存。保存する前に、サーバーがトークンでアカウントを確かめる。 */
function TokenConnectorForm({
  provider,
  field,
  saving,
}: {
  provider: ConnectorProviderView;
  field: NonNullable<ConnectorProviderView["token"]>;
  saving: boolean;
}) {
  const [token, setToken] = useState("");

  const save = (): void => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;

    void saveConnectorToken(provider.id, trimmed)
      .then(() => setToken(""))
      .catch(showConnectorsError);
  };

  return (
    <ConnectorForm
      setupUrl={provider.setupUrl}
      setupLabel={t("settings.connectors.openSetup")}
      submitLabel={t(saving ? "common.checking" : "settings.connectors.token.save")}
      submitDisabled={saving || token.trim().length === 0}
      onSubmit={save}
    >
      <Field label={field.label} description={field.description}>
        <input
          class={INPUT_CLASS}
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
      </Field>
    </ConnectorForm>
  );
}

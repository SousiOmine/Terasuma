import { useEffect, useState } from "preact/hooks";
import type { DiscordWebhookTeraView } from "../../../shared/api/discord";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import { t } from "../../i18n";
import {
  clearDiscordError,
  discord,
  discordError,
  isLoadingDiscord,
  loadDiscord,
  removeWebhook,
  saveWebhook,
  savingDiscord,
  showDiscordError,
  WEBHOOK_PLACEHOLDER,
} from "../../state/discord";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { SettingsError } from "../../ui/SettingsSection";
import { StatusBadge } from "../../ui/StatusBadge";
import { CollapsibleCard } from "../../ui/CollapsibleCard";
import { CARD_ACTION_CLASS, INPUT_CLASS } from "../../ui/styles";
import { ConnectorForm } from "./ConnectorForm";

/**
 * 設定 > コネクタ の Discord。
 *
 * 送信先の webhook は Tera ごとに 1 つ。URL は保存するだけで、画面には戻さない。
 * 保存する前に、サーバーが GET で webhook を確かめる（受け付けられない URL は保存しない）。
 */
export function DiscordWebhooksSection() {
  const view = discord.value;
  const error = discordError.value;
  const disconnecting = useDeleteTarget<{ id: string; name: string }>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (discord.value !== null || isLoadingDiscord.value) return;
    void loadDiscord().catch(showDiscordError);
  }, []);

  return (
    <div class="mt-8 border-t border-stroke pt-6">
      <h3 class="text-[13px] font-medium">Discord</h3>
      <p class="mt-1 text-xs leading-5 text-secondary">{t("settings.discord.description")}</p>

      <SettingsError error={error} onDismiss={clearDiscordError} />

      <div class="mt-3 space-y-2">
        {view === null ? (
          <p class="text-xs text-secondary">{t("common.loading")}</p>
        ) : view.teras.length === 0 ? (
          <p class="text-xs text-secondary">{t("settings.discord.empty")}</p>
        ) : (
          view.teras.map((tera) => (
            <DiscordWebhookCard
              key={tera.teraId}
              tera={tera}
              setupUrl={view.setupUrl}
              onDisconnect={() => disconnecting.open({ id: tera.teraId, name: tera.teraName })}
            />
          ))
        )}
      </div>

      {disconnecting.target !== null && (
        <ConfirmDialog
          title={t("settings.discord.disconnectTitle")}
          subject={disconnecting.target.name}
          message={t("settings.discord.disconnectMessage")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => disconnecting.confirm(removeWebhook, showDiscordError)}
          onCancel={disconnecting.close}
        />
      )}
    </div>
  );
}

type DiscordWebhookCardProps = {
  tera: DiscordWebhookTeraView;
  setupUrl: string;
  onDisconnect: () => void;
};

function DiscordWebhookCard({ tera, setupUrl, onDisconnect }: DiscordWebhookCardProps) {
  const saving = savingDiscord.value === tera.teraId;
  const [url, setUrl] = useState("");

  const save = (): void => {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;

    void saveWebhook(tera.teraId, trimmed)
      .then(() => setUrl(""))
      .catch(showDiscordError);
  };

  return (
    <CollapsibleCard
      title={tera.teraName}
      badge={
        <StatusBadge tone={tera.connected ? "success" : "neutral"}>
          {t(tera.connected ? "settings.connectors.state.connected" : "settings.connectors.state.disconnected")}
        </StatusBadge>
      }
      lines={[
        tera.connected && tera.channelId !== null ? t("settings.discord.channel", { channel: tera.channelId }) : null,
        tera.connected && tera.webhookName !== null
          ? t("settings.discord.webhookName", { name: tera.webhookName })
          : null,
        tera.detail,
      ]}
      action={
        tera.connected ? (
          <button type="button" onClick={onDisconnect} class={CARD_ACTION_CLASS}>
            {t("settings.discord.disconnect")}
          </button>
        ) : undefined
      }
    >
      <ConnectorForm
        setupUrl={setupUrl}
        setupLabel={t("settings.connectors.openSetup")}
        submitLabel={t(saving ? "settings.discord.saving" : "settings.discord.save")}
        submitDisabled={saving || url.trim().length === 0}
        onSubmit={save}
      >
        <Field label={t("settings.discord.field.label")} description={t("settings.discord.field.description")}>
          <input
            class={INPUT_CLASS}
            type="password"
            value={url}
            placeholder={WEBHOOK_PLACEHOLDER}
            aria-label={t("settings.discord.field.label")}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            disabled={saving}
            onInput={(event) => setUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              save();
            }}
          />
        </Field>
      </ConnectorForm>
    </CollapsibleCard>
  );
}

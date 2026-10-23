import { IconExternalLink } from "@tabler/icons-preact";
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
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { SettingsError } from "../../ui/SettingsSection";
import { StatusBadge } from "../../ui/StatusBadge";
import { CARD_ACTION_CLASS, CARD_CLASS, INPUT_CLASS } from "../../ui/styles";

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
    <div class={CARD_CLASS}>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <p class="truncate text-sm font-medium">{tera.teraName}</p>
            <StatusBadge tone={tera.connected ? "success" : "neutral"}>
              {t(tera.connected ? "settings.connectors.state.connected" : "settings.connectors.state.disconnected")}
            </StatusBadge>
            {tera.connected && tera.channelId !== null && (
              <span class="text-xs text-secondary">
                {t("settings.discord.channel", { channel: tera.channelId })}
              </span>
            )}
          </div>

          {tera.connected && tera.webhookName !== null && (
            <p class="mt-1 text-[11px] leading-5 text-secondary">
              {t("settings.discord.webhookName", { name: tera.webhookName })}
            </p>
          )}
          {tera.detail !== null && (
            <p class="mt-1.5 break-words text-xs leading-5 text-secondary">{tera.detail}</p>
          )}
        </div>

        {tera.connected && (
          <button type="button" onClick={onDisconnect} class={CARD_ACTION_CLASS}>
            {t("settings.discord.disconnect")}
          </button>
        )}
      </div>

      <div class="mt-3">
        <Field
          label={t("settings.discord.field.label")}
          description={t("settings.discord.field.description")}
        >
          <div class="flex items-center gap-2">
            <input
              class={`${INPUT_CLASS} min-w-0 flex-1`}
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
            <Button variant="primary" disabled={saving || url.trim().length === 0} onClick={save}>
              {t(saving ? "settings.discord.saving" : "settings.discord.save")}
            </Button>
          </div>
        </Field>

        <div class="flex flex-col gap-3 border-t border-stroke pt-3 sm:flex-row sm:items-center sm:justify-between">
          <a
            href={setupUrl}
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex items-center gap-1 text-xs text-secondary underline underline-offset-2"
          >
            <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
            {t("settings.discord.setup")}
          </a>
        </div>
      </div>
    </div>
  );
}

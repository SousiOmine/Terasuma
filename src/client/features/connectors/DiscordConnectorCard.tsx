import { useEffect, useState } from "preact/hooks";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import { t } from "../../i18n";
import {
  clearDiscordError,
  discord,
  discordError,
  isLoadingDiscord,
  loadDiscord,
  removeWebhook,
  saveWebhooks,
  savingDiscord,
  showDiscordError,
  WEBHOOK_PLACEHOLDER,
} from "../../state/discord";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { SettingsError } from "../../ui/SettingsSection";
import { StatusBadge } from "../../ui/StatusBadge";
import { CollapsibleCard } from "../../ui/CollapsibleCard";
import { INPUT_CLASS } from "../../ui/styles";
import { ConnectorForm } from "./ConnectorForm";

/**
 * 設定 > コネクタ の Discord。
 *
 * 1 枚のカードの中で Tera ごとの欄を持ち、webhook は Tera ごとに 1 つ。
 * URL は保存するだけで、画面には戻さない。
 * 保存する前に、サーバーが GET で webhook を確かめる（受け付けられない URL は保存しない）。
 */
export function DiscordConnectorCard() {
  const view = discord.value;
  const error = discordError.value;
  const saving = savingDiscord.value;
  const [urls, setUrls] = useState<Readonly<Record<string, string>>>({});
  const disconnecting = useDeleteTarget<{ id: string; name: string }>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (discord.value !== null || isLoadingDiscord.value) return;
    void loadDiscord().catch(showDiscordError);
  }, []);

  const teras = view?.teras ?? [];
  const connected = teras.filter((tera) => tera.connected).length;

  // 空の欄は保存しない。入力した Tera だけをまとめて送る。
  const filled = Object.entries(urls).filter(([, url]) => url.trim().length !== 0);

  const save = (): void => {
    if (filled.length === 0) return;

    void saveWebhooks(filled.map(([teraId, url]) => ({ teraId, url })))
      .then(() => setUrls({}))
      .catch(showDiscordError);
  };

  return (
    <>
      <SettingsError error={error} onDismiss={clearDiscordError} />

      <CollapsibleCard
        title="Discord"
        badge={
          <StatusBadge tone={connected > 0 ? "success" : "neutral"}>
            {t("settings.discord.badge", { connected, total: teras.length })}
          </StatusBadge>
        }
        lines={[
          t("settings.discord.description"),
          ...(view === null ? [t("common.loading")] : view.teras.length === 0 ? [t("settings.discord.empty")] : []),
        ]}
      >
        {view !== null && view.teras.length > 0 && (
          <>
            <p class="text-xs leading-5 text-secondary">{t("settings.discord.field.description")}</p>

            <ConnectorForm
              setupUrl={view.setupUrl}
              setupLabel={t("settings.connectors.openSetup")}
              submitLabel={t(saving ? "common.checking" : "settings.discord.save")}
              submitDisabled={saving || filled.length === 0}
              onSubmit={save}
            >
              {view.teras.map((tera) => {
                const description = [
                  tera.connected && tera.channelId !== null
                    ? t("settings.discord.channel", { channel: tera.channelId })
                    : null,
                  tera.connected && tera.webhookName !== null
                    ? t("settings.discord.webhookName", { name: tera.webhookName })
                    : null,
                ]
                  .filter((line): line is string => line !== null)
                  .join(" / ");

                return (
                  <Field
                    key={tera.teraId}
                    label={tera.teraName}
                    description={description.length > 0 ? description : undefined}
                    hint={tera.detail ?? undefined}
                  >
                    <input
                      class={INPUT_CLASS}
                      type="password"
                      value={urls[tera.teraId] ?? ""}
                      placeholder={WEBHOOK_PLACEHOLDER}
                      aria-label={`${tera.teraName}: ${t("settings.discord.field.label")}`}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      disabled={saving}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        setUrls((current) => ({ ...current, [tera.teraId]: value }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        save();
                      }}
                    />
                    {tera.connected && (
                      <button
                        type="button"
                        class="mt-2 self-start text-xs text-secondary underline underline-offset-2 hover:text-primary"
                        onClick={() => disconnecting.open({ id: tera.teraId, name: tera.teraName })}
                      >
                        {t("settings.discord.disconnect")}
                      </button>
                    )}
                  </Field>
                );
              })}
            </ConnectorForm>
          </>
        )}
      </CollapsibleCard>

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
    </>
  );
}

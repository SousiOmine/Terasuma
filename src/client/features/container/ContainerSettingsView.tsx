import { useEffect, useState } from "preact/hooks";
import type { ContainerState } from "../../../shared/types";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import type { MessageKey } from "../../i18n";
import { t } from "../../i18n";
import {
  clearContainerError,
  computerEnv,
  containerBusy,
  containerError,
  containerStatus,
  loadComputerEnv,
  loadContainer,
  removeComputerEnv,
  resetContainer,
  showContainerError,
  startContainer,
} from "../../state/container";
import { Button } from "../../ui/Button";
import { DeleteAction } from "../../ui/CardActions";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SettingsSection } from "../../ui/SettingsSection";
import { CARD_CLASS } from "../../ui/styles";

/** 状態の表示。文言は i18n にまとめる（状態に色は付けない）。 */
const STATE_LABELS: Record<ContainerState, MessageKey> = {
  podman_missing: "settings.container.state.podman_missing",
  image_missing: "settings.container.state.image_missing",
  container_missing: "settings.container.state.container_missing",
  stopped: "settings.container.state.stopped",
  running: "settings.container.state.running",
};

/**
 * 設定の「コンピュータ」（podman のコンテナ）。
 *
 * 状態は podman に問い合わせた結果をそのまま出す。操作は 起動 と リセット の 2 つで、
 * リセットだけは何が消えるかを確かめてから実行する。止める操作は置かない。
 * 起動は面倒を見る範囲が広い（イメージが無ければ作り、コンテナが無ければ作る）ので、
 * 利用者に順番を覚えさせない。
 */
export function ContainerSettingsView() {
  const status = containerStatus.value;
  const busy = containerBusy.value;
  const error = containerError.value;
  const env = computerEnv.value;

  const [resetting, setResetting] = useState(false);
  const [wipeHome, setWipeHome] = useState(false);
  /** 削除の確認。環境変数は名前だけを持つので、対象も名前で持つ。 */
  const deleting = useDeleteTarget<{ id: string }>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、ここでも状態を読み直す。
    void loadContainer().catch(showContainerError);
    void loadComputerEnv().catch(showContainerError);
  }, []);

  const run = (operation: () => Promise<void>) => {
    clearContainerError();
    void operation().catch(showContainerError);
  };

  const confirmReset = () => {
    const wipe = wipeHome;
    setResetting(false);
    setWipeHome(false);
    run(() => resetContainer(wipe));
  };

  return (
    <SettingsSection title={t("settings.container")} error={error} onDismiss={clearContainerError}>
      <p class="mt-1 text-xs text-[var(--app-text-secondary)]">{t("settings.container.description")}</p>

      <div class={`mt-6 ${CARD_CLASS}`}>
        <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div class="min-w-0">
            <p class="text-xs text-[var(--app-text-secondary)]">{t("settings.container.state.label")}</p>
            <p class="mt-1 text-sm">{status === null ? t("common.checking") : t(STATE_LABELS[status.state])}</p>
          </div>

          {status !== null && status.state !== "podman_missing" && (
            <div class="flex shrink-0 flex-wrap gap-2">
              {status.state !== "running" && (
                <Button variant="primary" disabled={busy !== null} onClick={() => run(startContainer)}>
                  {busy === "start" ? t("settings.container.starting") : t("settings.container.start")}
                </Button>
              )}
              <Button
                disabled={busy !== null}
                onClick={() => {
                  setWipeHome(false);
                  setResetting(true);
                }}
              >
                {busy === "reset" ? t("settings.container.resetting") : t("settings.container.reset")}
              </Button>
            </div>
          )}
        </div>

        {status?.detail != null && (
          <p class="mt-3 break-words text-xs text-[var(--app-text-secondary)]">{status.detail}</p>
        )}

        {status?.state === "podman_missing" && (
          <p class="mt-3 text-xs text-[var(--app-text-secondary)]">{t("settings.container.podmanMissing")}</p>
        )}

        {status !== null && status.state !== "running" && status.state !== "podman_missing" && (
          <p class="mt-3 text-xs text-[var(--app-text-secondary)]">{t("settings.container.firstBuild")}</p>
        )}
      </div>

      {/* エージェントがチャットで受け取った値。名前だけを出し、値は API も画面も扱わない。 */}
      <div class={`mt-4 ${CARD_CLASS}`}>
        <p class="text-sm font-medium">{t("settings.container.env.title")}</p>

        {env === null ? (
          <p class="mt-3 text-xs text-[var(--app-text-secondary)]">{t("common.loading")}</p>
        ) : env.length === 0 ? (
          <p class="mt-3 text-xs text-[var(--app-text-secondary)]">{t("settings.container.env.empty")}</p>
        ) : (
          <ul class="mt-3 flex flex-col gap-1">
            {env.map((name) => (
              <li
                key={name}
                class="flex items-center justify-between gap-3 rounded-[12px] bg-[var(--app-surface)] px-3 py-1.5"
              >
                <code class="min-w-0 truncate font-mono text-xs">{name}</code>
                <DeleteAction onClick={() => deleting.open({ id: name })} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {resetting && (
        <ConfirmDialog
          title={t("settings.container.resetTitle")}
          message={t("settings.container.resetMessage")}
          confirmLabel={t("settings.container.confirmReset")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={confirmReset}
          onCancel={() => {
            setResetting(false);
            setWipeHome(false);
          }}
        >
          <label class="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={wipeHome}
              onChange={(event) => setWipeHome(event.currentTarget.checked)}
              class="shrink-0"
            />
            {t("settings.container.resetWipeHome")}
          </label>
        </ConfirmDialog>
      )}

      {deleting.target !== null && (
        <ConfirmDialog
          title={t("settings.container.env.deleteTitle")}
          subject={deleting.target.id}
          message={t("settings.container.env.deleteMessage")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => deleting.confirm(removeComputerEnv, showContainerError)}
          onCancel={deleting.close}
        />
      )}
    </SettingsSection>
  );
}

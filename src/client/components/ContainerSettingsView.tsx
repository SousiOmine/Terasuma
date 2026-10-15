import { useEffect, useState } from "preact/hooks";
import type { ContainerState } from "../../shared/types";
import type { MessageKey } from "../i18n";
import { t } from "../i18n";
import {
  clearContainerError,
  containerBusy,
  containerError,
  containerStatus,
  loadContainer,
  resetContainer,
  showContainerError,
  startContainer,
  stopContainer,
} from "../containerSettings";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorNotice } from "./ErrorNotice";

/** 状態の表示。文言は i18n、色はこの 1 箇所にまとめる。 */
const STATE_LABELS: Record<ContainerState, MessageKey> = {
  podman_missing: "settings.container.state.podman_missing",
  image_missing: "settings.container.state.image_missing",
  container_missing: "settings.container.state.container_missing",
  stopped: "settings.container.state.stopped",
  running: "settings.container.state.running",
};

const STATE_CLASSES: Record<ContainerState, string> = {
  podman_missing: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  image_missing: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  container_missing: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  stopped: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  running: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
};

/**
 * 設定の「コンテナ」。
 *
 * 状態は podman に問い合わせた結果をそのまま出す。操作は 停止・起動・リセット の 3 つで、
 * リセットだけは何が消えるかを確かめてから実行する。
 * 起動は面倒を見る範囲が広い（イメージが無ければ作り、コンテナが無ければ作る）ので、
 * 利用者に順番を覚えさせない。
 */
export function ContainerSettingsView() {
  const status = containerStatus.value;
  const busy = containerBusy.value;
  const error = containerError.value;

  const [resetting, setResetting] = useState(false);
  const [wipeHome, setWipeHome] = useState(false);

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、ここでも状態を読み直す。
    void loadContainer().catch(showContainerError);
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
    <div class="mx-auto w-full max-w-2xl">
      <h2 class="text-base font-semibold">{t("settings.container")}</h2>
      <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("settings.container.description")}</p>

      <div class="mt-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="text-xs text-neutral-500 dark:text-neutral-400">{t("settings.container.state.label")}</p>
            <p class="mt-1 flex items-center gap-2">
              {status === null ? (
                <span class="text-sm text-neutral-500 dark:text-neutral-400">
                  {t("settings.container.state.checking")}
                </span>
              ) : (
                <span class={`rounded-md px-2 py-0.5 text-xs ${STATE_CLASSES[status.state]}`}>
                  {t(STATE_LABELS[status.state])}
                </span>
              )}
              {status?.vncPort != null && (
                <span class="text-xs text-neutral-500 dark:text-neutral-400">
                  {t("settings.container.vncPort")}: {status.vncPort}
                </span>
              )}
            </p>
          </div>

          {status !== null && status.state !== "podman_missing" && (
            <div class="flex shrink-0 gap-2">
              {status.state === "running" ? (
                <Button disabled={busy} onClick={() => run(stopContainer)}>
                  {busy ? t("settings.container.stopping") : t("settings.container.stop")}
                </Button>
              ) : (
                <Button variant="primary" disabled={busy} onClick={() => run(startContainer)}>
                  {busy ? t("settings.container.starting") : t("settings.container.start")}
                </Button>
              )}
              <Button
                disabled={busy}
                onClick={() => {
                  setWipeHome(false);
                  setResetting(true);
                }}
              >
                {busy ? t("settings.container.resetting") : t("settings.container.reset")}
              </Button>
            </div>
          )}
        </div>

        {status?.detail != null && (
          <p class="mt-3 break-words text-xs text-amber-800 dark:text-amber-300">{status.detail}</p>
        )}

        {status?.state === "podman_missing" && (
          <p class="mt-3 text-xs text-neutral-500 dark:text-neutral-400">{t("settings.container.podmanMissing")}</p>
        )}

        {status !== null && status.state !== "running" && status.state !== "podman_missing" && (
          <p class="mt-3 text-xs text-neutral-500 dark:text-neutral-400">{t("settings.container.firstBuild")}</p>
        )}
      </div>

      {error !== null && (
        <div class="mt-4">
          <ErrorNotice
            error={error}
            action={
              <button
                type="button"
                onClick={clearContainerError}
                class="text-xs opacity-70 transition hover:opacity-100"
              >
                {t("error.dismiss")}
              </button>
            }
          />
        </div>
      )}

      {resetting && (
        <ConfirmDialog
          title={t("settings.container.resetTitle")}
          message={t("settings.container.resetMessage")}
          confirmLabel={t("settings.container.confirmReset")}
          cancelLabel={t("settings.container.cancel")}
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
    </div>
  );
}

import { useEffect } from "preact/hooks";
import type { Tera } from "../../../shared/api/message";
import type { RoutineView } from "../../../shared/api/routine";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import { t } from "../../i18n";
import { focusTeraId } from "../../state/route";
import {
  clearRoutinesError,
  isLoadingRoutines,
  loadRoutines,
  removeRoutine,
  routines,
  routinesError,
  refreshRoutines,
  runNow,
  savingRoutine,
  setEnabled,
  showRoutinesError,
  stopRun,
} from "../../state/routines";
import { refreshTeras, teras } from "../../state/session";
import { clearTeraError, removeTera, showTeraError, teraError } from "../../state/teras";
import { DeleteAction } from "../../ui/CardActions";
import { CollapsibleCard } from "../../ui/CollapsibleCard";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SettingsError, SettingsSection } from "../../ui/SettingsSection";
import { StatusBadge } from "../../ui/StatusBadge";
import { CARD_ACTION_CLASS } from "../../ui/styles";
import { nextRunLabel, scheduleLabel, statusLabel } from "../routines/labels";

// 実行中は結果が変わるので、終わったことと最後の結果を出すために見回す。
const RUNNING_POLL_MS = 3_000;

/**
 * 設定 > Tera。
 *
 * 会話の持ち主（Tera）の一覧。カードを開くと、その Tera のルーチン（決まった時刻に
 * 自分から走るターン）を出す。削除は、履歴・identity・Discord の webhook・
 * 作業フォルダをまとめて消す（取り消せない）ので、確認してから行う。
 * 最後の 1 体を消すと、既定の Tera が作り直される。
 */
export function TeraSettingsView() {
  const items = teras.value;
  const error = teraError.value;
  const deleting = useDeleteTarget<Tera>();
  const deletingRoutine = useDeleteTarget<RoutineView>();
  const hasRunning = routines.value?.routines.some((routine) => routine.running) ?? false;

  useEffect(() => {
    // チャットを開かずに設定へ来た場合に備えて、一覧を読み直す。
    void refreshTeras().catch(showTeraError);
    // ルーチンも、まだ読めていなければここで読む。
    if (routines.value !== null || isLoadingRoutines.value) return;
    void loadRoutines().catch(showRoutinesError);
  }, []);

  useEffect(() => {
    if (!hasRunning) return;

    const id = setInterval(() => {
      void refreshRoutines().catch((failure) => {
        // 同じ失敗を 3 秒ごとに出し続けない。次の操作で読み直せばよい。
        clearInterval(id);
        showRoutinesError(failure);
      });
    }, RUNNING_POLL_MS);

    return () => clearInterval(id);
  }, [hasRunning]);

  return (
    <SettingsSection title={t("settings.teras")} error={error} onDismiss={clearTeraError}>
      <p class="mt-2 text-xs leading-5 text-secondary">{t("settings.teras.description")}</p>

      <div class="mt-4 space-y-2">
        {items.map((tera) => (
          <TeraCard
            key={tera.id}
            tera={tera}
            onDelete={() => deleting.open(tera)}
            onDeleteRoutine={(routine) => deletingRoutine.open(routine)}
          />
        ))}
      </div>

      {deleting.target !== null && (
        <ConfirmDialog
          title={t("tera.deleteTitle")}
          subject={deleting.target.name}
          message={t("tera.deleteMessage")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => deleting.confirm(removeTera, showTeraError)}
          onCancel={deleting.close}
        />
      )}

      {deletingRoutine.target !== null && (
        <ConfirmDialog
          title={t("routine.deleteTitle")}
          subject={deletingRoutine.target.name}
          message={t("routine.deleteMessage", { name: deletingRoutine.target.name })}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => deletingRoutine.confirm(removeRoutine, showRoutinesError)}
          onCancel={deletingRoutine.close}
        />
      )}
    </SettingsSection>
  );
}

function TeraCard({
  tera,
  onDelete,
  onDeleteRoutine,
}: {
  tera: Tera;
  onDelete: () => void;
  onDeleteRoutine: (routine: RoutineView) => void;
}) {
  const all = routines.value?.routines ?? [];
  const items = all.filter((routine) => routine.teraId === tera.id);
  const loading = routines.value === null && isLoadingRoutines.value;
  const error = routinesError.value;

  return (
    <CollapsibleCard
      title={tera.name}
      lines={[t("settings.teras.id", { id: tera.id })]}
      badge={
        items.length > 0 ? (
          <StatusBadge tone="neutral">{t("routine.badge", { count: items.length })}</StatusBadge>
        ) : undefined
      }
      action={<DeleteAction onClick={onDelete} />}
      defaultOpen={focusTeraId.value === tera.id}
    >
      <div class="mt-1 space-y-2">
        <p class="text-xs leading-5 text-secondary">{t("settings.teras.routines.description")}</p>

        <SettingsError error={error} onDismiss={clearRoutinesError} />

        {loading ? (
          <p class="text-xs text-secondary">{t("common.loading")}</p>
        ) : items.length === 0 ? (
          <p class="text-xs text-secondary">{t("settings.teras.routines.empty")}</p>
        ) : (
          items.map((routine) => (
            <RoutineRow key={routine.id} routine={routine} onDelete={() => onDeleteRoutine(routine)} />
          ))
        )}
      </div>
    </CollapsibleCard>
  );
}

/** ルーチン 1 件。操作はこの行の中だけに置き、別のファイルは作らない。 */
function RoutineRow({ routine, onDelete }: { routine: RoutineView; onDelete: () => void }) {
  const saving = savingRoutine.value === routine.id;
  const details = [
    scheduleLabel(routine.schedule),
    routine.nextRunAt === null ? "" : t("routine.next", { at: nextRunLabel(routine.nextRunAt) }),
    statusLabel(routine.lastStatus),
  ]
    .filter((part) => part.length > 0)
    .join("・");

  return (
    <div class="rounded-[16px] bg-surface p-3">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <p class="truncate text-[13px] font-medium">{routine.name}</p>
            <StatusBadge tone={routine.enabled ? "success" : "neutral"}>
              {t(routine.enabled ? "routine.enable" : "routine.disable")}
            </StatusBadge>
          </div>
          <p class="mt-0.5 text-[11px] leading-5 text-secondary">{details}</p>
          {routine.lastDetail !== null && (
            <p class="mt-0.5 break-words text-[11px] leading-5 text-secondary">{routine.lastDetail}</p>
          )}
        </div>

        <div class="flex flex-wrap justify-end gap-1.5">
          <button
            type="button"
            disabled={saving}
            onClick={() => void setEnabled(routine.id, !routine.enabled).catch(showRoutinesError)}
            class={`${CARD_ACTION_CLASS} disabled:opacity-50`}
          >
            {t(routine.enabled ? "routine.disable" : "routine.enable")}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              void (routine.running ? stopRun(routine.id) : runNow(routine.id)).catch(showRoutinesError)
            }
            class={`${CARD_ACTION_CLASS} disabled:opacity-50`}
          >
            {t(routine.running ? "routine.stop" : "routine.run")}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onDelete}
            class={`${CARD_ACTION_CLASS} disabled:opacity-50`}
          >
            {t("common.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

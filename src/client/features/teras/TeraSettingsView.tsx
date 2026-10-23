import { useEffect } from "preact/hooks";
import type { Tera } from "../../../shared/api/message";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import { t } from "../../i18n";
import { refreshTeras, teras } from "../../state/session";
import { clearTeraError, removeTera, showTeraError, teraError } from "../../state/teras";
import { DeleteAction } from "../../ui/CardActions";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SettingsSection } from "../../ui/SettingsSection";
import { CARD_CLASS } from "../../ui/styles";

/**
 * 設定 > Tera。
 *
 * 会話の持ち主（Tera）の一覧。削除は、履歴・identity・Discord の webhook・
 * 作業フォルダをまとめて消す（取り消せない）ので、確認してから行う。
 * 最後の 1 体を消すと、既定の Tera が作り直される。
 */
export function TeraSettingsView() {
  const items = teras.value;
  const error = teraError.value;
  const deleting = useDeleteTarget<Tera>();

  useEffect(() => {
    // チャットを開かずに設定へ来た場合に備えて、一覧を読み直す。
    void refreshTeras().catch(showTeraError);
  }, []);

  return (
    <SettingsSection title={t("settings.teras")} error={error} onDismiss={clearTeraError}>
      <p class="mt-2 text-xs leading-5 text-secondary">{t("settings.teras.description")}</p>

      <div class="mt-4 space-y-2">
        {items.map((tera) => (
          <TeraCard key={tera.id} tera={tera} onDelete={() => deleting.open(tera)} />
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
    </SettingsSection>
  );
}

function TeraCard({ tera, onDelete }: { tera: Tera; onDelete: () => void }) {
  return (
    <div class={`${CARD_CLASS} flex items-start justify-between gap-3`}>
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{tera.name}</p>
        <p class="mt-0.5 truncate text-xs text-secondary">{t("settings.teras.id", { id: tera.id })}</p>
      </div>
      <DeleteAction onClick={onDelete} />
    </div>
  );
}

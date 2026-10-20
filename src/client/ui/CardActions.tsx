import { IconPencil, IconTrash } from "@tabler/icons-preact";
import { t } from "../i18n";
import { CARD_ACTION_CLASS } from "./styles";

/**
 * カードの中の操作。
 * プロバイダと MCP サーバーの一覧が同じ形（アイコン + 短い文言）なので、見た目を揃える。
 */

export function EditAction({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} class={`${CARD_ACTION_CLASS} flex items-center gap-1`}>
      <IconPencil size={14} stroke={1.6} class="shrink-0" />
      {t("common.edit")}
    </button>
  );
}

export function DeleteAction({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={`${CARD_ACTION_CLASS} flex items-center gap-1 text-red-600 dark:text-red-400`}
    >
      <IconTrash size={14} stroke={1.6} class="shrink-0" />
      {t("common.delete")}
    </button>
  );
}

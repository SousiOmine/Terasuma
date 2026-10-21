import type { ComponentChildren } from "preact";
import { Button } from "./Button";
import { Modal } from "./Modal";

export type ConfirmDialogProps = {
  /** 見出し。何を確認するのかを書く。 */
  title: string;
  /** 操作の対象。見出しの下に名前を出す。 */
  subject?: string;
  /** 取り消せないなどの補足。 */
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 取り消せない操作のとき true。確定ボタンを赤くする。 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 確認の前に選ばせる項目など、本文へ足す内容。 */
  children?: ComponentChildren;
};

/** 画面の中央に出す確認ダイアログ。 */
export function ConfirmDialog({
  title,
  subject,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {subject !== undefined && (
        <p class="truncate rounded-2xl bg-[var(--app-soft)] px-4 py-2.5 text-sm font-medium">
          {subject}
        </p>
      )}
      <p class="mt-3 text-xs leading-5 text-[var(--app-text-secondary)]">{message}</p>
      {children}
    </Modal>
  );
}

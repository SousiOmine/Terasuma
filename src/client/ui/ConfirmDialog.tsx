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
        <p class="truncate rounded-lg bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">{subject}</p>
      )}
      <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{message}</p>
      {children}
    </Modal>
  );
}

import { useState } from "preact/hooks";

/**
 * 一覧から 1 件を消すときの「対象 → 確認 → 実行」。
 *
 * どの設定画面でも同じ形（対象を持つ → 確認ダイアログを出す → 消す → 失敗は画面に出す）に
 * なるので、状態の持ち方だけをここにまとめる。
 */
export type DeleteTarget<T> = {
  /** 確認中の対象。無ければ null。 */
  target: T | null;
  open(value: T): void;
  close(): void;
  /** 確認されたら消す。失敗は onError に渡す。 */
  confirm(remove: (id: string) => Promise<unknown>, onError: (error: unknown) => void): void;
};

export function useDeleteTarget<T extends { id: string }>(): DeleteTarget<T> {
  const [target, setTarget] = useState<T | null>(null);

  return {
    target,
    open(value) {
      setTarget(value);
    },
    close() {
      setTarget(null);
    },
    confirm(remove, onError) {
      const current = target;
      setTarget(null);
      if (current === null) return;

      void remove(current.id).catch(onError);
    },
  };
}

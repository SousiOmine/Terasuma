import { createPendingRegistry } from "./pending";

/**
 * 「接続が終わるまで待つ」ツールの待ちを、キーごとにまとめる。
 *
 * コネクタと Discord は、どちらも「複数のツールが同じ相手を待ち、保存で解く」形になる。
 * Map と abort の後始末は pending.ts が持ち、ここでは解決・失敗の配り方だけをそろえる。
 */

/** 待っているツール 1 つ。 */
type Waiter = {
  resolve(text: string): void;
  reject(error: unknown): void;
};

export type WaiterQueue<Key> = {
  /** 待ちを登録する。中断済み、または同じキーに既に待ちがあるなら、その場で失敗する。 */
  wait(key: Key, signal: AbortSignal, ended: string): Promise<string>;
  /** 待っているツールを、成功の文で解く。 */
  resolveAll(key: Key, text: string): void;
  /** 待っているツールを、理由を付けて失敗させる。 */
  rejectAll(key: Key, error: unknown): void;
  /** 待っているキー。 */
  keys(): readonly Key[];
  /** すべての待ちを、理由を付けて失敗させる（終了時）。 */
  close(message: string): void;
};

export function createWaiterQueue<Key>(): WaiterQueue<Key> {
  const pending = createPendingRegistry<Key, Waiter>({ multiple: true });

  return {
    wait(key, signal, ended) {
      return new Promise<string>((resolve, reject) => {
        const entry = pending.register(key, { resolve, reject }, signal, () => reject(new Error(ended)));
        if (entry === null) reject(new Error(ended));
      });
    },

    resolveAll(key, text) {
      for (const entry of pending.takeAll(key)) entry.pending.resolve(text);
    },

    rejectAll(key, error) {
      for (const entry of pending.takeAll(key)) entry.pending.reject(error);
    },

    keys() {
      return pending.keys();
    },

    close(message) {
      for (const key of pending.keys()) {
        for (const entry of pending.takeAll(key)) entry.pending.reject(new Error(message));
      }
    },
  };
}

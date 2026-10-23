/**
 * 中断で片付く待ちの置き場。
 *
 * 画面の引き受け、環境変数の入力、アプリの接続の待ちは、どれも「待ちを登録する、返事で解く、
 * ターンが止まったら外す」という同じ形になる。Map と abort の listener の後始末をここに 1 つ置き、
 * 各機能は「何を待ち、返事をどう解くか」だけを書く。
 *
 * 待ちの成否は呼び出し側が決める。ここは待ちを外して listener を抜くだけで、resolve も reject もしない。
 */

/** 登録した待ち 1 つ。 */
export type PendingEntry<Pending> = {
  readonly pending: Pending;
  /** 中断の listener を外す。待ちの成否は呼び出し側が決める。 */
  close(): void;
};

export type PendingRegistry<Key, Pending> = {
  /**
   * 待ちを登録する。中断済み、または同じキーに既に待ちがある（multiple でない）なら null。
   * null のときは listener も付けない。
   */
  register(key: Key, pending: Pending, signal: AbortSignal, onAbort: () => void): PendingEntry<Pending> | null;
  /** 取り出さずに先頭の 1 つを見る。 */
  first(key: Key): PendingEntry<Pending> | null;
  /** すべて取り出す。Map から消し、中断の listener も外す。 */
  takeAll(key: Key): PendingEntry<Pending>[];
  /** 待っているキー。 */
  keys(): readonly Key[];
};

export function createPendingRegistry<Key, Pending>(
  options: { multiple?: boolean } = {},
): PendingRegistry<Key, Pending> {
  const waiting = new Map<Key, PendingEntry<Pending>[]>();

  function detach(key: Key, entry: PendingEntry<Pending>): void {
    const entries = waiting.get(key);
    if (entries === undefined) return;

    const rest = entries.filter((item) => item !== entry);
    if (rest.length === 0) waiting.delete(key);
    else waiting.set(key, rest);
  }

  return {
    register(key, pending, signal, onAbort) {
      if (signal.aborted) return null;

      const current = waiting.get(key) ?? [];
      if (options.multiple !== true && current.length > 0) return null;

      let removeListener = (): void => undefined;
      const entry: PendingEntry<Pending> = { pending, close: () => removeListener() };

      const onAbortSignal = (): void => {
        detach(key, entry);
        removeListener();
        onAbort();
      };

      removeListener = () => signal.removeEventListener("abort", onAbortSignal);
      current.push(entry);
      waiting.set(key, current);
      signal.addEventListener("abort", onAbortSignal, { once: true });
      return entry;
    },

    first(key) {
      return waiting.get(key)?.[0] ?? null;
    },

    takeAll(key) {
      const entries = waiting.get(key);
      if (entries === undefined) return [];

      waiting.delete(key);
      for (const entry of entries) entry.close();
      return entries;
    },

    keys() {
      return [...waiting.keys()];
    },
  };
}

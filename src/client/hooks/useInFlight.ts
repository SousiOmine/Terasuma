import { useRef } from "preact/hooks";

/**
 * 送信中の操作を 1 つに絞る門。
 *
 * 状態の更新は描画を挟むため、素早く二度押しされると busy が立つ前に 2 回目が走る。
 * 押した瞬間に閉じる門を ref で持ち、同じ形を各ダイアログに書き写さない。
 */
export type InFlight = {
  /** 実行中でなければ action を始める。実行中なら何もしない。 */
  run(action: () => Promise<void>): void;
  /** いま実行中かどうか。 */
  isRunning(): boolean;
};

export function useInFlight(): InFlight {
  const current = useRef(false);

  return {
    run(action) {
      if (current.current) return;
      current.current = true;
      void action().finally(() => {
        current.current = false;
      });
    },
    isRunning() {
      return current.current;
    },
  };
}

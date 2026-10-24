import { createPendingRegistry } from "../wait/pending";

/**
 * エージェントからユーザーへ画面を渡す（引き受け）。
 *
 * ログインや二段階認証のように、人の手が要る場面で使う。
 * 待っている間、エージェントは画面を撮らずに待つ（入力を覗かないため）。
 *
 * 引き受けは Tera ごとに 1 つだけ持つ。別のタブで別の Tera が動いていても混ざらない。
 * 待ちはターンの中で作られるので、停止で signal が立ち、そこで終わる。
 */

/** ユーザーからの返し方。 */
export type HandoverAnswer =
  /** 「操作を完了した」を押した。 */
  | { kind: "done" }
  /** チャットに書いて送った文。 */
  | { kind: "text"; text: string };

/** 「操作を完了した」ときの戻り値。 */
export const HANDOVER_DONE = "The user finished working on the computer.";

/** ターンが終わって、待ちを続けられなくなったときの理由。 */
const HANDOVER_ENDED = "The turn ended before the screen was handed over";

export type Handover = {
  /**
   * ユーザーに渡して待つ。返事か「操作を完了した」で解決する。
   * ターンが止まった場合（signal）は、待たずに終わったことを伝える。
   */
  wait(teraId: string, signal: AbortSignal): Promise<string>;
  /** ユーザーからの返事。待っているものが無ければ false。 */
  answer(teraId: string, answer: HandoverAnswer): boolean;
};

export function createHandover(): Handover {
  /** Tera の id → 待ちを終わらせる関数。 */
  const pending = createPendingRegistry<string, (answer: HandoverAnswer) => void>();

  return {
    wait(teraId, signal) {
      return new Promise<string>((resolve, reject) => {
        // すでに止まったターンから呼ばれることがある（停止と ask_user が競合した場合）。
        // ここで断らないと、誰も返事をしない待ちが残り、ターンが片付かない。
        if (signal.aborted) {
          reject(new Error(HANDOVER_ENDED));
          return;
        }

        const entry = pending.register(
          teraId,
          (answer) => resolve(answer.kind === "done" ? HANDOVER_DONE : answer.text),
          signal,
          () => reject(new Error(HANDOVER_ENDED)),
        );

        // 同じ Tera で二重に待つことはない（ターンは 1 つずつ進む）。
        if (entry === null) reject(new Error(HANDOVER_ENDED));
      });
    },

    answer(teraId, answer) {
      const entries = pending.takeAll(teraId);
      if (entries.length === 0) return false;

      for (const entry of entries) entry.pending(answer);
      return true;
    },
  };
}

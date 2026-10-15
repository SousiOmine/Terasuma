/**
 * エージェントからユーザーへ画面を渡す（引き受け）。
 *
 * ログインや二段階認証のように、人の手が要る場面で使う。
 * 待っている間、エージェントは画面を撮らずに待つ（入力を覗かないため）。
 *
 * 引き受けはセッションごとに 1 つだけ持つ。別のタブで別の会話が動いていても混ざらない。
 * 待ちはターンの中で作られるので、停止やタブの切断で signal が立ち、そこで終わる。
 */

/** ユーザーからの返し方。 */
export type HandoverAnswer =
  /** 「操作を完了した」を押した。 */
  | { kind: "done" }
  /** チャットに書いて送った文。 */
  | { kind: "text"; text: string };

/** 「操作を完了した」ときの戻り値。 */
export const HANDOVER_DONE = "ユーザーは操作を完了しました";

export type Handover = {
  /**
   * ユーザーに渡して待つ。返事か「操作を完了した」で解決する。
   * ターンが止まった場合（signal）は、待たずに終わったことを伝える。
   */
  wait(sessionId: string, signal: AbortSignal): Promise<string>;
  /** ユーザーからの返事。待っているものが無ければ false。 */
  answer(sessionId: string, answer: HandoverAnswer): boolean;
  /** いま待っているかどうか。 */
  pending(sessionId: string): boolean;
  /** 待ちを片付ける（画面を渡せないままターンが終わった場合）。 */
  cancel(sessionId: string): void;
};

export function createHandover(): Handover {
  /** セッション id → 待ちを終わらせる関数。 */
  const waiting = new Map<string, (answer: HandoverAnswer) => void>();

  return {
    wait(sessionId, signal) {
      return new Promise<string>((resolve, reject) => {
        const settle = (answer: HandoverAnswer): void => {
          waiting.delete(sessionId);
          signal.removeEventListener("abort", onAbort);
          resolve(answer.kind === "done" ? HANDOVER_DONE : answer.text);
        };

        const onAbort = (): void => {
          waiting.delete(sessionId);
          reject(new Error("画面を渡す前にターンが終わりました"));
        };

        // 同じセッションで二重に待つことはない（ターンは 1 つずつ進む）。
        waiting.set(sessionId, settle);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },

    answer(sessionId, answer) {
      const settle = waiting.get(sessionId);
      if (settle === undefined) return false;

      settle(answer);
      return true;
    },

    pending(sessionId) {
      return waiting.has(sessionId);
    },

    cancel(sessionId) {
      const settle = waiting.get(sessionId);
      if (settle === undefined) return;

      settle({ kind: "done" });
    },
  };
}

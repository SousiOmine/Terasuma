import type { ChatEvent, ChatMessage } from "../../shared/api/message";
import type { RunningTurn, SteerInput, TurnDeps, TurnInput, TurnOrigin } from "./turn-types";
import { runTurn } from "./turn-stream";

export type { SteerInput, TurnDeps, TurnInput, TurnOrigin } from "./turn-types";

/**
 * 1 ターン分の流れと、同じ Tera でターンが重ならないための門。
 *
 * ルーチンのターンも同じ 1 本の枠を使う（重ねない）。
 *
 * 保存 → モデル呼び出し → 保存、の順で進み、履歴は常に追記だけになる。
 * 「実行中かどうか」はこのモジュールの中だけで持ち、HTTP 層へ Set を渡さない。
 *
 * ターンは 1 つ以上の区切りからなる。応答の途中で利用者が発言を足したら、
 * その区切りの中では次のモデル呼び出しの直前（prepareStep）に文脈へ足す。
 * 最後の呼び出しに間に合わなかった発言は、ターンを終える前に続きの区切りで応答する。
 *
 * モデルの本文は text パートとして画面へ流す。画像やファイルはエージェントが
 * chat_attach で添付し（parts の attachment）、システムの注記は notice に残る。
 */

/** ターンを流すのに必要なもの。 */
export type Turns = {
  /**
   * ターンを始める。同じ Tera で実行中なら null（重ねて流さない）。
   * 終わったら（止められた場合も）実行中の印は必ず外れる。
   * startUserMessage が false なら、最初の区切りでユーザー発言を保存しない（再試行用）。
   */
  begin(
    teraId: string,
    input: TurnInput,
    options?: { startUserMessage?: boolean; origin?: TurnOrigin },
  ): AsyncIterable<ChatEvent> | null;
  /** 応答を生成しているターンがあるかどうか。 */
  isRunning(teraId: string): boolean;
  /** いま走っているターンを始めたきっかけ。走っていなければ null。 */
  runningOrigin(teraId: string): TurnOrigin | null;
  /**
   * この Tera のターンが登録されているかどうか（停止を押して、片付けている途中も含む）。
   * Tera を消す前に確かめる。止めたターンは、終わるまで履歴を書き足すため。
   */
  hasTurn(teraId: string): boolean;
  /**
   * 走っているターンの途中へ、利用者の発言を足す。
   * 発言は保存され、次のモデル呼び出しの直前に文脈の末尾へ入る。
   * ターンが動いていない（止めている途中を含む）なら null。何も保存しない。
   */
  steer(teraId: string, input: SteerInput): ChatMessage | null;
  /**
   * 走っているターンを止める。エージェントはそこで打ち切り、それまでに書いた
   * 本文や添付は保存して assistant-done で返す。
   * 止めるターンが無ければ false（すでに終わっている。呼び直しても害はない）。
   */
  stop(teraId: string): boolean;
  /**
   * 走っているすべてのターンを止め、保存が終わるまで待つ。
   * 終了の直前に呼ぶ（DB を閉じた後で書き込ませないため）。
   */
  close(): Promise<void>;
};

/** 一時的な失敗のときに、やり直すまでの待ち（ミリ秒）。回数はこの配列の長さ。 */
export function createTurns(deps: TurnDeps): Turns {
  const { store } = deps;

  /** いま応答を生成している Tera と、その中止の口。 */
  const running = new Map<string, RunningTurn>();

  return {
    begin(teraId, input, options) {
      const origin: TurnOrigin = options?.origin ?? { kind: "user" };

      // 画面は 1 つのターンしか始めないが、別のタブから同じ Tera を開けるため、ここでも断る。
      if (running.has(teraId)) return null;

      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const turn: RunningTurn = {
        controller: new AbortController(),
        stopped: false,
        pending: [],
        origin,
        done,
        finish,
      };
      running.set(teraId, turn);
      return runTurn(deps, teraId, input, turn, running, options?.startUserMessage ?? true);
    },

    isRunning(teraId) {
      const turn = running.get(teraId);
      return turn !== undefined && !turn.stopped;
    },

    runningOrigin(teraId) {
      return running.get(teraId)?.origin ?? null;
    },

    hasTurn(teraId) {
      return running.has(teraId);
    },

    steer(teraId, input) {
      const turn = running.get(teraId);
      // 止めている途中のターンには足さない。足しても応答しないまま履歴に残る。
      if (turn === undefined || turn.stopped) return null;

      const message = store.appendMessage({
        id: crypto.randomUUID(),
        teraId,
        role: "user",
        content: input.content,
        attachments: input.attachments,
        origin: null,
      });
      turn.pending.push(message);
      return message;
    },

    stop(teraId) {
      const turn = running.get(teraId);
      if (turn === undefined) return false;

      turn.stopped = true;
      turn.controller.abort();
      return true;
    },

    async close() {
      // 止めたターンは、それまでの本文と添付を保存してから終わる。書き込みが終わるまで待つ。
      const turns = [...running.values()];
      for (const turn of turns) {
        turn.stopped = true;
        turn.controller.abort();
      }
      if (turns.length === 0) return;

      // 一度も読まれなかったイベント列は終わらない（ジェネレータは最初の next で動き出す）。
      // 終了を待ち続けないよう、上限を置く。
      const done = Promise.allSettled(turns.map((turn) => turn.done));
      await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
    },
  };
}

/** close() が、走っているターンの片付けを待つ上限（ミリ秒）。 */
const CLOSE_TIMEOUT_MS = 10_000;

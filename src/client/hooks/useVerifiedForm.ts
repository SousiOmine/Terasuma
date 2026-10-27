import { useRef, useState } from "preact/hooks";
import type { ErrorState } from "../lib/errors";
import { toErrorState } from "../lib/errors";

/**
 * 「入力を確かめる → 保存する」ダイアログの、状態の持ち方。
 *
 * MCP サーバー・Web 検索プロバイダ・モデルプロバイダの追加は、どれも
 * 「入力を変えたら確かめ直し」「確かめて通ったものだけ保存できる」「二度押しを防ぐ」
 * という同じ形をしている。3 つのダイアログが同じ状態機械を書き写していたので、ここにまとめる。
 *
 * 確かめた結果は、そのときの入力の署名と組にして持つ。入力を変えたら結果を捨てるので、
 * 「変えたのに前の確認のまま保存できる」状態にならない。
 */

/** いま走っている操作。 */
export type VerifiedFormBusy = "checking" | "saving" | null;

export type VerifiedForm<S> = {
  /** 走っている操作。 */
  readonly busy: VerifiedFormBusy;
  /** いまの失敗。 */
  readonly error: ErrorState | null;
  /** いまの入力に対する確認結果。確かめていなければ null。 */
  readonly checked: S | null;
  /** 失敗を置く（呼び出し側の検証でも使う）。 */
  setError(error: ErrorState | null): void;
  /** 入力を変えた。確認結果と失敗を捨てる。 */
  invalidate(): void;
  /** 確かめる。通ったら結果を持ち、通らなければ失敗を持って null を返す。 */
  check(verify: () => Promise<S | null>): Promise<S | null>;
  /**
   * 保存する。二度押しは無視する。
   * 成功したら true。失敗は error に入れて false を返す。
   */
  save(save: () => Promise<void>): Promise<boolean>;
  /**
   * いまの操作の番号。認可のように「待っている間に別の操作が始まったら諦める」判断に使う。
   * 入力が変わったときや閉じたときにも進む。
   */
  generation(): number;
  /** 失敗を消す（確かめ直す前など）。 */
  clearError(): void;
  /** 確かめた結果を置く（認可を待つ間に、別の経路で結果が届いたとき）。 */
  setChecked(result: S): void;
  /** 走っている確かめ・保存の結果を捨てる（ダイアログを閉じたとき）。 */
  cancelPending(): void;
};

export function useVerifiedForm<S>(signature: string): VerifiedForm<S> {
  const [busy, setBusy] = useState<VerifiedFormBusy>(null);
  const [error, setErrorState] = useState<ErrorState | null>(null);
  const [checked, setChecked] = useState<{ signature: string; result: S } | null>(null);

  /** 走っている操作の番号。閉じた後・入力が変わった後に届いた結果を捨てる。 */
  const run = useRef(0);
  /** 押した瞬間に閉じる門（描画を挟むと二度押しが通ってしまう）。 */
  const inFlight = useRef(false);

  const checkedNow = checked !== null && checked.signature === signature ? checked.result : null;

  return {
    busy,
    error,
    checked: checkedNow,
    setError(error) {
      setErrorState(error);
    },
    invalidate() {
      run.current += 1;
      setChecked(null);
      setErrorState(null);
    },
    async check(verify) {
      if (inFlight.current) return checkedNow;

      const mine = ++run.current;
      setBusy("checking");
      setErrorState(null);
      try {
        const result = await verify();
        if (mine !== run.current) return null;
        // 確かめた側が結果を自分で置いた場合（認可の待ちなど）は、null が返る。上書きしない。
        if (result !== null) setChecked({ signature, result });
        return result;
      } catch (failure) {
        if (mine !== run.current) return null;
        setErrorState(toErrorState(failure));
        return null;
      } finally {
        if (mine === run.current) setBusy(null);
      }
    },
    async save(save) {
      if (inFlight.current) return false;

      inFlight.current = true;
      const mine = ++run.current;
      setBusy("saving");
      setErrorState(null);
      try {
        await save();
        return mine === run.current;
      } catch (failure) {
        if (mine === run.current) setErrorState(toErrorState(failure));
        return false;
      } finally {
        inFlight.current = false;
        if (mine === run.current) setBusy(null);
      }
    },
    generation() {
      return run.current;
    },
    clearError() {
      setErrorState(null);
    },
    setChecked(result) {
      setChecked({ signature, result });
    },
    cancelPending() {
      run.current += 1;
      inFlight.current = false;
      setBusy(null);
    },
  };
}

import { signal, type Signal } from "@preact/signals";
import { createErrorSignal, type ErrorState } from "../lib/errors";

/**
 * サーバから読む一覧の共通形。
 *
 * 「まだ読めていなければ読む」「読み込み中は重ねない」「読み直したいときは強制的に読む」を
 * 1 か所に置く。画面ごとに「まだ読めていなければ読む」effect と loading の旗を書き写さない。
 *
 * 失敗も持つ。data が null のままなのは「まだ読めていない」と「読めなかった」の 2 通りあり、
 * これを区別しないと、失敗した画面が「読み込み中」を出し続ける。
 */
export type Resource<T> = {
  readonly data: Signal<T | null>;
  readonly loading: Signal<boolean>;
  /** 直近の読み込みの失敗。成功したら null に戻る。 */
  readonly error: Signal<ErrorState | null>;
  /** まだ読めていなければ読む。読み込み中なら、その読み込みを待つ。 */
  load(): Promise<void>;
  /** 読めていても読み直す。読み込み中でも、新しい読み込みを始める。 */
  refresh(): Promise<void>;
  /** 失敗を画面から消す。 */
  clearError(): void;
};

export function createResource<T>(loader: () => Promise<T>): Resource<T> {
  const data = signal<T | null>(null);
  const loading = signal(false);
  const failure = createErrorSignal();

  /** 最後に始めた読み込みの番号。古い応答は捨てる。 */
  let generation = 0;
  /** 走っている読み込み。同じ読み込みを二重に始めないために使う。 */
  let inFlight: Promise<void> | null = null;

  function run(): Promise<void> {
    const mine = ++generation;
    loading.value = true;
    failure.clear();

    const job = loader()
      .then((value) => {
        // 新しい読み込みが始まっていたら、この結果は古い。画面を巻き戻さない。
        if (mine !== generation) return;
        data.value = value;
      })
      .catch((error: unknown) => {
        if (mine !== generation) return;
        failure.show(error);
      })
      .finally(() => {
        if (mine !== generation) return;
        loading.value = false;
        if (inFlight === job) inFlight = null;
      });

    inFlight = job;
    return job;
  }

  return {
    data,
    loading,
    error: failure.error,

    load() {
      if (data.value !== null) return Promise.resolve();
      if (inFlight !== null) return inFlight;
      return run();
    },

    refresh() {
      // 読み直しは、走っている読み込みを待たない（待つと、古い内容で終わってしまう）。
      return run();
    },

    clearError() {
      failure.clear();
    },
  };
}

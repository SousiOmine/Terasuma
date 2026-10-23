import { signal, type Signal } from "@preact/signals";

/**
 * サーバから読む一覧の共通形。
 *
 * 「まだ読めていなければ読む」「読み込み中は重ねない」「読み直したいときは強制的に読む」を
 * 1 か所に置く。画面ごとに「まだ読めていなければ読む」effect と loading の旗を書き写さない。
 */
export type Resource<T> = {
  readonly data: Signal<T | null>;
  readonly loading: Signal<boolean>;
  /** まだ読めていなければ読む。読み込み中なら、その読み込みを待つ。 */
  load(): Promise<void>;
  /** 読めていても読み直す。 */
  refresh(): Promise<void>;
};

export function createResource<T>(loader: () => Promise<T>): Resource<T> {
  const data = signal<T | null>(null);
  const loading = signal(false);
  let inFlight: Promise<void> | null = null;

  function run(): Promise<void> {
    loading.value = true;

    const job = loader()
      .then((value) => {
        data.value = value;
      })
      .finally(() => {
        loading.value = false;
        if (inFlight === job) inFlight = null;
      });

    inFlight = job;
    return job;
  }

  return {
    data,
    loading,
    load() {
      if (data.value !== null) return Promise.resolve();
      if (inFlight !== null) return inFlight;
      return run();
    },
    refresh() {
      if (inFlight !== null) return inFlight;
      return run();
    },
  };
}

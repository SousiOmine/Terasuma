/**
 * 一定の間隔で状態を尋ね続ける。
 *
 * OAuth の認可のように、ブラウザの別タブで進む処理は、こちらから状態を尋ねるしかない。
 * 「待つ → 尋ねる → 終わったか見る → 中断されたか見る」という形は
 * MCP の設定画面と追加ダイアログの 2 か所で同じになるので、ここに 1 つだけ置く。
 */

/** 尋ね続けた結果。 */
export type PollOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown };

export type PollOptions<T> = {
  /** 尋ねる間隔。 */
  intervalMs: number;
  /** 待ち続ける上限。過ぎたら timeout を返す。 */
  timeoutMs: number;
  /** 尋ねる処理。 */
  probe: () => Promise<T>;
  /** これ以上待つ必要が無いかどうか。 */
  done: (value: T) => boolean;
  /** 待つのをやめる条件（画面が閉じた、別の操作が始まったなど）。 */
  cancelled: () => boolean;
  /** 時刻と待ち。テストで差し替える。 */
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
};

export async function pollUntil<T>(options: PollOptions<T>): Promise<PollOutcome<T>> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;

  while (!options.cancelled() && now() < deadline) {
    await delay(options.intervalMs);
    if (options.cancelled()) return { kind: "cancelled" };

    try {
      const value = await options.probe();
      if (options.cancelled()) return { kind: "cancelled" };
      if (options.done(value)) return { kind: "value", value };
    } catch (error) {
      return { kind: "error", error };
    }
  }

  return options.cancelled() ? { kind: "cancelled" } : { kind: "timeout" };
}

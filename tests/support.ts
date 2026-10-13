import { createStore } from "../src/server/store";

/** 時刻を固定したストア。updated_at の比較を決定的にするため。 */
export function makeStore() {
  let tick = 1_000;
  return createStore(":memory:", { now: () => (tick += 1) });
}

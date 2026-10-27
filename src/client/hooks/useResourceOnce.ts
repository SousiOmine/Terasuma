import { useEffect } from "preact/hooks";
import type { Resource } from "../state/resource";

/**
 * 画面を開いたときに、まだ読めていなければ読む。
 *
 * 「設定画面を直接開いた場合に備えて、まだ読めていなければここで読む」という同じ effect が
 * 各画面に書き写されていた。Resource の load は「読めていれば何もしない」を自分で持つので、
 * 画面側での分岐は要らない（分岐を書くと、読み込み中かどうかの判定が画面ごとにぶれる）。
 *
 * 失敗は Resource の error に入り、画面はそれを表示する。
 */
export function useResourceOnce(resource: Pick<Resource<unknown>, "load">): void {
  const { load } = resource;

  // load は Resource が持つ関数で、画面の寿命の間は変わらない。
  useEffect(() => {
    void load();
  }, [load]);
}

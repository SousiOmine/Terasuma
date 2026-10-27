import type { ComponentChildren } from "preact";
import { t } from "../i18n";
import type { ErrorState } from "../lib/errors";
import { ErrorNotice } from "./ErrorNotice";

/**
 * サーバから読んだ一覧の並び。
 *
 * 「読み込み中」「失敗」「空」「一覧」の 4 分岐は、プロバイダ・MCP・Web 検索・コネクタの設定で
 * 同じ形になる。1 件ずつの見た目は呼び出し側が決め、ここは並べ方と、まだ出せないときの表示だけを持つ。
 *
 * 失敗と「まだ読めていない」を分けるのは、両方 data が null になるため。
 * 分けないと、読めなかった画面が「読み込み中」を出し続ける。
 */
export function ResourceList<T>({
  data,
  empty,
  loading,
  error,
  children,
}: {
  /** まだ読めていないときは null。 */
  data: readonly T[] | null;
  /** 1 件も無いときの文言。 */
  empty: string;
  /** 読み込み中の表示を出すかどうか。省くと「data が null なら読み込み中」になる。 */
  loading?: boolean;
  /** 読み込めなかった理由。あれば「読み込み中」ではなくこれを出す。 */
  error?: ErrorState | null;
  children: (item: T) => ComponentChildren;
}) {
  const isLoading = loading ?? (data === null && (error === undefined || error === null));

  return (
    <div class="mt-3 space-y-2">
      {data === null ? (
        error !== undefined && error !== null ? (
          <ErrorNotice error={error} />
        ) : isLoading ? (
          <p class="text-xs text-secondary">{t("common.loading")}</p>
        ) : (
          <p class="text-xs text-secondary">{empty}</p>
        )
      ) : data.length === 0 ? (
        <p class="text-xs text-secondary">{empty}</p>
      ) : (
        data.map(children)
      )}
    </div>
  );
}

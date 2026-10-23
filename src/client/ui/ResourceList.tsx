import type { ComponentChildren } from "preact";
import { t } from "../i18n";

/**
 * サーバから読んだ一覧の並び。
 *
 * 「読み込み中」「空」「一覧」の 3 分岐は、プロバイダ・MCP・Web 検索の設定で同じ形になる。
 * 1 件ずつの見た目は呼び出し側が決め、ここは並べ方と空のときの文言だけを持つ。
 */
export function ResourceList<T>({
  data,
  empty,
  loading = data === null,
  children,
}: {
  /** まだ読めていないときは null。 */
  data: readonly T[] | null;
  /** 1 件も無いときの文言。 */
  empty: string;
  /** 読み込み中の表示を出すかどうか。null の理由が読み込み以外なら false にする。 */
  loading?: boolean;
  children: (item: T) => ComponentChildren;
}) {
  return (
    <div class="mt-3 space-y-2">
      {data === null ? (
        loading ? (
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

import type { ErrorState } from "../lib/errors";
import { t } from "../i18n";
import { ErrorNotice } from "./ErrorNotice";

/**
 * 「まだ読めていない」と「読めなかった」の出し分け。
 *
 * data が null になるのは、読み込み中と失敗の 2 通りある。区別しないと、
 * 失敗した画面が「読み込み中」を出し続け、読み込みが終わらないように見える。
 */
export function LoadOrError({ loading, error }: { loading: boolean; error: ErrorState | null }) {
  if (error !== null) return <ErrorNotice error={error} />;
  if (loading) return <p class="text-xs text-secondary">{t("common.loading")}</p>;
  return null;
}

/**
 * 画面で繰り返す Tailwind の組み合わせ。
 *
 * 同じ文字列を各コンポーネントに書き写すと、片方だけ直して見た目がずれる。
 * 見た目の部品（コンポーネント）にするほどではないが、複数箇所で同じ形になるものだけをここに置く。
 */

/** 1 行の入力欄。 */
export const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-600";

/** 複数行の入力欄（コマンドや環境変数）。 */
export const TEXTAREA_CLASS = `${INPUT_CLASS} font-mono text-xs leading-relaxed`;

/** 検索欄（左にアイコンを置く分、左だけ余白を広く取る）。 */
export const SEARCH_INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white py-1.5 pl-8 pr-3 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-600";

/** カードの中の小さな操作（編集・削除・再確認）。 */
export const CARD_ACTION_CLASS =
  "rounded-lg px-2 py-1 text-xs transition hover:bg-neutral-100 dark:hover:bg-neutral-800";

/** 項目の説明文。 */
export const DESC_CLASS = "mt-0.5 text-xs text-neutral-500 dark:text-neutral-400";

/** 選択肢を横に並べる枠（言語、MCP の種類、プロバイダの切り替え）。 */
export const SEGMENTED_CLASS = "flex gap-1 rounded-lg bg-neutral-200/60 p-0.5 dark:bg-neutral-800";

/** 選ばれている選択肢。 */
export const SEGMENTED_ON_CLASS = "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900";

/** 選ばれていない選択肢。 */
export const SEGMENTED_OFF_CLASS =
  "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-700";

/** 検索欄の虫眼鏡。 */
export const SEARCH_ICON_CLASS = "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400";

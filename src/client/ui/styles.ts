/**
 * 画面で繰り返す Tailwind の組み合わせ。
 *
 * 同じ文字列を各コンポーネントに書き写すと、片方だけ直して見た目がずれる。
 * 見た目の部品（コンポーネント）にするほどではないが、複数箇所で同じ形になるものだけをここに置く。
 *
 * 色は styles.css の --app-* トークンだけを使う。ここに hex を書くと、
 * アクセント 1 色という規則が画面ごとに崩れる。
 */

/** 入力欄の共通の面。文字の大きさだけを用途ごとに足す（同じ強さの class を重ねない）。 */
const FIELD_BASE =
  "w-full rounded-[14px] border border-[var(--app-stroke)] bg-[var(--app-surface-alt)] px-3.5 py-2.5 text-[var(--app-text)] outline-none transition placeholder:text-[var(--app-text-tertiary)] focus:border-[var(--app-accent)] focus:bg-[var(--app-surface)] focus:ring-4 focus:ring-[var(--app-ring)]";

/** 1 行の入力欄。面を薄く敷き、フォーカス時だけアクセントの輪を出す。 */
export const INPUT_CLASS = `${FIELD_BASE} text-sm`;

/** 複数行の入力欄（コマンドや環境変数）。 */
export const TEXTAREA_CLASS = `${FIELD_BASE} font-mono text-xs leading-relaxed`;

/** 検索欄（左にアイコンを置く分、左だけ余白を広く取る）。 */
export const SEARCH_INPUT_CLASS = `${FIELD_BASE} py-2.5 pl-10 pr-4 text-sm`;

/** カードの中の小さな操作（編集・削除・再確認）。狭い画面では指で押せる高さにする。 */
export const CARD_ACTION_CLASS =
  "rounded-full px-3 py-2 text-xs font-medium text-[var(--app-text-secondary)] transition hover:bg-[var(--app-soft-strong)] hover:text-[var(--app-text)] md:px-2.5 md:py-1.5";

/** 一覧の中に置くカード。設定の面（白）の上に、薄い灰の面で区切る。 */
export const CARD_CLASS = "rounded-[20px] bg-[var(--app-surface-alt)] p-5";

/** 項目の説明文。 */
export const DESC_CLASS = "mt-1 text-xs leading-5 text-[var(--app-text-secondary)]";

/** 選択肢を横に並べる枠（言語、MCP の種類、プロバイダの切り替え）。 */
export const SEGMENTED_CLASS = "flex gap-1 rounded-full bg-[var(--app-soft)] p-1";

/** 選ばれている選択肢。アクセントで塗り、文字を反転する。 */
export const SEGMENTED_ON_CLASS =
  "rounded-full bg-[var(--app-accent-fill)] font-medium text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)]";

/** 選ばれていない選択肢。 */
export const SEGMENTED_OFF_CLASS =
  "rounded-full text-[var(--app-text-secondary)] hover:bg-[var(--app-surface)] hover:text-[var(--app-text)]";

/** 検索欄の虫眼鏡。 */
export const SEARCH_ICON_CLASS =
  "pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--app-text-tertiary)]";

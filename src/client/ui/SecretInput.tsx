import { useState } from "preact/hooks";
import { INPUT_CLASS } from "./styles";

/**
 * 秘密の値（API キー、トークン）の入力欄。
 *
 * 表示の切り替えと、切り替えボタンの文言をここにまとめる。
 * 値そのものは呼び出し側が持ち、この部品は入力された値を返すだけにする。
 */
export function SecretInput({
  value,
  label,
  placeholder,
  showLabel,
  hideLabel,
  onInput,
}: {
  value: string;
  /** 入力欄の読み上げ名。 */
  label: string;
  placeholder: string;
  /** 表示に切り替えるボタンの文言。 */
  showLabel: string;
  /** 隠すボタンの文言。 */
  hideLabel: string;
  onInput: (value: string) => void;
}) {
  const [reveal, setReveal] = useState(false);

  const common = {
    value,
    autocomplete: "off",
    spellcheck: false,
    "aria-label": label,
    placeholder,
    class: `${INPUT_CLASS} min-w-0 flex-1`,
    onInput: (event: { currentTarget: HTMLInputElement }) => onInput(event.currentTarget.value),
  };

  return (
    <div class="flex items-center gap-2">
      {/* type は文字列で切り替えず、要素ごとに分ける（型が属性ごとの union のため）。 */}
      {reveal ? <input type="text" {...common} /> : <input type="password" {...common} />}
      <button
        type="button"
        onClick={() => setReveal(!reveal)}
        class="shrink-0 rounded-full px-2.5 py-1 text-xs text-secondary transition hover:bg-soft hover:text-primary"
      >
        {reveal ? hideLabel : showLabel}
      </button>
    </div>
  );
}

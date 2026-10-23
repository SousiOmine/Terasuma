import { SEGMENTED_CLASS, SEGMENTED_OFF_CLASS, SEGMENTED_ON_CLASS } from "./styles";

/**
 * 横に並べた選択肢（タブのような切り替え）。
 * 言語、MCP サーバーの種類、プロバイダの切り替えが同じ形なので 1 か所にまとめる。
 */
export type SegmentedOption<Value extends string> = {
  value: Value;
  label: string;
};

export function Segmented<Value extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <div class={SEGMENTED_CLASS}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            class={`flex-1 rounded-full px-3 py-1.5 text-xs transition active:scale-[0.98] md:py-1 ${active ? SEGMENTED_ON_CLASS : SEGMENTED_OFF_CLASS}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

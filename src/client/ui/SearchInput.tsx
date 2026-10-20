import { IconSearch } from "@tabler/icons-preact";
import { SEARCH_ICON_CLASS, SEARCH_INPUT_CLASS } from "./styles";

/**
 * 絞り込み用の検索欄。虫眼鏡と入力欄の組み合わせを 1 か所にまとめる。
 */
export function SearchInput({
  value,
  onInput,
  placeholder,
}: {
  value: string;
  onInput: (value: string) => void;
  /** 入力の説明。placeholder と同じ文言でよい。 */
  placeholder: string;
}) {
  return (
    <div class="relative">
      <IconSearch size={16} stroke={1.6} class={SEARCH_ICON_CLASS} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        class={SEARCH_INPUT_CLASS}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
    </div>
  );
}

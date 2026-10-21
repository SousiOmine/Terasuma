/**
 * 相手（Tera）のアイコン。
 * 名前はヘッダーに出ているので、ここは飾りとして読み上げない。
 */
export function ChatAvatar({ size = 30, class: className = "" }: { size?: number; class?: string }) {
  return (
    <div
      aria-hidden="true"
      class={`flex shrink-0 select-none items-center justify-center rounded-full bg-gradient-to-br from-[#06c755] to-[#078f45] font-semibold text-white shadow-sm ring-2 ring-white dark:ring-neutral-900 ${className}`}
      style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.44)}px` }}
    >
      T
    </div>
  );
}

/**
 * 相手（Tera）のアイコン。
 * 名前はヘッダーに出ているので、ここは飾りとして読み上げない。
 *
 * 塗りは墨 1 色。グラデーションや輪郭は使わず、丸だけで見せる。
 */
export function ChatAvatar({ size = 30, class: className = "" }: { size?: number; class?: string }) {
  return (
    <div
      aria-hidden="true"
      class={`flex shrink-0 select-none items-center justify-center rounded-full bg-[var(--app-ink-fill)] font-semibold text-[var(--app-on-ink)] shadow-[var(--app-shadow-2)] ${className}`}
      style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.44)}px` }}
    >
      T
    </div>
  );
}

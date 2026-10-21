/**
 * 相手（Tera）のアイコン。
 * 名前はヘッダーに出ているので、ここは飾りとして読み上げない。
 *
 * このアプリで唯一、色と光を持つ記号。アイリスのオーブに墨の T を置き、
 * ほかの面はすべて無彩色に保つ。グラデーションは styles.css の .tera-orb が持つ。
 */
export function ChatAvatar({ size = 30, class: className = "" }: { size?: number; class?: string }) {
  return (
    <div
      aria-hidden="true"
      class={`tera-orb flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-[var(--app-orb-ink)] ${className}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * 0.42)}px`,
        letterSpacing: "-0.03em",
      }}
    >
      T
    </div>
  );
}

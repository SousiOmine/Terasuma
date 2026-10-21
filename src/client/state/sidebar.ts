import { signal } from "@preact/signals";

/**
 * サイドバー（ドロワー）の開閉。
 *
 * md 以上ではサイドバーが常に出ているので、この状態は幅の狭い画面でだけ意味を持つ。
 * 画面の切り替え（route.ts）とは別に置く。開いているのは一時的な重なりであり、
 * 表示している画面そのものを変えるわけではないため。
 */
export const sidebarOpen = signal(false);

export function toggleSidebar(): void {
  sidebarOpen.value = !sidebarOpen.value;
}

export function closeSidebar(): void {
  sidebarOpen.value = false;
}

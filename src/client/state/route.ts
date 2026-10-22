import { signal } from "@preact/signals";

/**
 * 画面の切り替え。設定は全画面で開き、チャットのレイアウトごと差し替える。
 */

/** 表示中の画面。 */
export type View = "chat" | "settings";

/** 設定画面のカテゴリ。導線から特定のカテゴリを直接開くために signal で持つ。 */
export type SettingsCategory = "general" | "model" | "providers" | "container" | "advanced";

export const view = signal<View>("chat");
export const settingsCategory = signal<SettingsCategory>("general");

/** 設定画面を開く。導線に合わせて、開くカテゴリを指定できる。 */
export function openSettings(category: SettingsCategory = "general"): void {
  settingsCategory.value = category;
  view.value = "settings";
}

export function closeSettings(): void {
  view.value = "chat";
}

/** カテゴリだけを切り替える（設定画面の左ペイン）。 */
export function setSettingsCategory(category: SettingsCategory): void {
  settingsCategory.value = category;
}

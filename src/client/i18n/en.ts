/**
 * 英語の辞書を基準にする。MessageKey はこのキー集合から作られるので、
 * 他の言語にキーの過不足があると型エラーになり、tests/i18n.test.ts でも検出する。
 */
export const en = {
  "app.name": "Terasuma",

  "sidebar.new": "New chat",
  "sidebar.untitled": "New chat",
  "sidebar.empty": "No conversations yet",
  "sidebar.rename": "Rename conversation",
  "sidebar.renameHint": "Double-click to rename",
  "sidebar.delete": "Delete conversation",
  "sidebar.confirmDelete": "Delete",
  "sidebar.cancel": "Cancel",

  "chat.empty.title": "What can I help you with?",
  "chat.empty.hint": "Your conversations are stored only on this machine.",
  "chat.loading": "Loading…",
  "chat.replying": "Replying…",

  "composer.placeholder": "Send a message",
  "composer.send": "Send",
  "composer.stop": "Stop",
  "composer.hint": "Enter to send, Shift + Enter for a new line",

  "settings.title": "Settings",
  "settings.back": "Back to chat",
  "settings.general": "General",
  "settings.language.label": "Language",
  "settings.language.description": "Language used in the interface.",

  "error.invalid_request": "The message could not be sent.",
  "error.session_not_found": "This conversation no longer exists.",
  "error.model_error": "The model did not respond.",
  "error.internal_error": "Something went wrong.",
  "error.network": "The server is not reachable.",
  "error.dismiss": "Dismiss",
} as const;

export type MessageKey = keyof typeof en;

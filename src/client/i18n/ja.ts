import type { MessageKey } from "./en";

/** 日本語は既定の表示言語。en と同じキーを過不足なく持つことを型とテストで担保する。 */
export const ja: Record<MessageKey, string> = {
  "app.name": "Terasuma",

  "sidebar.new": "新しいチャット",
  "sidebar.untitled": "新しいチャット",
  "sidebar.empty": "まだ会話がありません",
  "sidebar.rename": "会話の名前を変更",
  "sidebar.renameHint": "ダブルクリックで名前を変更",
  "sidebar.delete": "会話を削除",
  "sidebar.confirmDelete": "削除する",
  "sidebar.cancel": "やめる",

  "chat.empty.title": "何をお手伝いしましょうか",
  "chat.empty.hint": "会話はこの端末の中だけに保存されます。",
  "chat.loading": "読み込み中…",
  "chat.replying": "応答を生成しています…",

  "composer.placeholder": "メッセージを入力",
  "composer.send": "送信",
  "composer.stop": "停止",
  "composer.hint": "Enter で送信、Shift + Enter で改行",

  "settings.title": "設定",
  "settings.back": "チャットに戻る",
  "settings.general": "一般",
  "settings.language.label": "言語",
  "settings.language.description": "画面の表示に使う言語",

  "error.invalid_request": "送信できませんでした。",
  "error.session_not_found": "この会話はすでに存在しません。",
  "error.model_error": "モデルから応答を得られませんでした。",
  "error.internal_error": "問題が発生しました。",
  "error.network": "サーバーに接続できません。",
  "error.dismiss": "閉じる",
};

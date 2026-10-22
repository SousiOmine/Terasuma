import { CHAT_SERVER_ID, UI_TOOL } from "../../shared/tools";
import type { MessagePart } from "../../shared/types";
import { parseUiMarkup, type UiChoiceBlock, type UiFormBlock, type UiView } from "../../shared/ui-markup";

/**
 * チャットに描く UI のカード。
 *
 * カードは専用の部品として保存せず、chat_ui のツール呼び出しの引数から組み立てる。
 * ツール呼び出しは履歴に残り、ストリームでも届くので、表示のための保存形式を増やさない。
 *
 * 押した選択肢は、待ちではなく新しいユーザー発言として送る。
 * その文の組み立てはここに置き、画面の部品から切り離して確かめられるようにする。
 */

/** カード 1 枚分。view が null なら、マークアップを読めなかった。 */
export type ChatUiPart = {
  type: "ui";
  callId: string;
  view: UiView | null;
};

/** ツール呼び出しが chat_ui なら、カードの材料を返す。ほかのツールなら null。 */
export function chatUiPartOf(part: MessagePart): ChatUiPart | null {
  if (part.type !== "tool-call") return null;
  if (part.server !== CHAT_SERVER_ID || part.tool !== UI_TOOL) return null;

  return { type: "ui", callId: part.id, view: viewFromArgs(part.args) };
}

/**
 * 選んだ選択肢のラベルを、ユーザーの発言にする。
 * 選ばれていない（空の）ときは空文字を返し、呼び出し側が送らないようにする。
 */
export function choiceMessage(choice: UiChoiceBlock, selected: readonly number[]): string {
  return selected
    .map((index) => choice.options[index]?.label)
    .filter((label): label is string => label !== undefined)
    .join(", ");
}

/**
 * フォームの入力を、ユーザーの発言にする。
 * 空の任意の欄は省き、チェックボックスは常に「はい／いいえ」で残す。
 */
export function formMessage(
  form: UiFormBlock,
  values: Readonly<Record<number, string | boolean>>,
  words: { yes: string; no: string },
): string {
  const lines: string[] = [];

  form.fields.forEach((field, index) => {
    const value = values[index];
    if (field.type === "checkbox") {
      lines.push(`${field.label}: ${value === true ? words.yes : words.no}`);
      return;
    }

    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > 0) lines.push(`${field.label}: ${text}`);
  });

  return lines.join("\n");
}

/** 必須の欄がすべて埋まっているか。送信できるかを決める。 */
export function formComplete(form: UiFormBlock, values: Readonly<Record<number, string | boolean>>): boolean {
  return form.fields.every((field, index) => {
    if (!field.required) return true;

    const value = values[index];
    if (field.type === "checkbox") return value === true;
    return typeof value === "string" && value.trim().length > 0;
  });
}

/** ツール呼び出しの引数から、カードのマークアップを取り出す。読めなければ null。 */
function viewFromArgs(args: unknown): UiView | null {
  const markup = readMarkup(args);
  if (markup === null) return null;

  const parsed = parseUiMarkup(markup);
  return parsed.ok ? parsed.view : null;
}

function readMarkup(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;

  const markup = (args as Record<string, unknown>)["markup"];
  return typeof markup === "string" ? markup : null;
}

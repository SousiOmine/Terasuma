import { describe, expect, test } from "bun:test";
import { chatUiPartOf, choiceMessage, formComplete, formMessage } from "../../src/client/lib/ui";
import type { MessagePart } from "../../src/shared/types";
import type { UiChoiceBlock, UiFormBlock } from "../../src/shared/ui-markup";

/**
 * カードの材料の取り出しと、押したときに送る文。
 * DOM を使わないので、そのまま確かめられる。
 */

const markup = "<Card><Text>選んでください</Text><Choice><Option>A案</Option><Option>B案</Option></Choice></Card>";

const choice: UiChoiceBlock = {
  type: "choice",
  multiple: false,
  options: [
    { label: "A案", description: null },
    { label: "B案", description: "詳しい" },
  ],
};

const form: UiFormBlock = {
  type: "form",
  submit: null,
  fields: [
    { label: "名前", type: "text", required: true, placeholder: null, options: [] },
    { label: "人数", type: "number", required: false, placeholder: null, options: [] },
    {
      label: "プラン",
      type: "select",
      required: false,
      placeholder: null,
      options: [
        { label: "無料", description: null },
        { label: "Pro", description: null },
      ],
    },
    { label: "同意", type: "checkbox", required: true, placeholder: null, options: [] },
  ],
};

function toolCall(args: unknown, id = "c1"): MessagePart {
  return { type: "tool-call", id, server: "chat", tool: "ui", args };
}

describe("チャットの UI", () => {
  test("chat_ui の呼び出しだけをカードにする", () => {
    const ui = chatUiPartOf(toolCall({ markup }));

    expect(ui?.type).toBe("ui");
    expect(ui?.callId).toBe("c1");
    expect(ui?.view?.blocks[0]).toEqual({ type: "text", text: "選んでください" });

    // ほかのツールや、ツール呼び出しでない部品は拾わない。
    expect(
      chatUiPartOf({ type: "tool-call", id: "c2", server: "chat", tool: "attach", args: { files: [] } }),
    ).toBeNull();
    expect(chatUiPartOf({ type: "text", text: "a", at: 1 })).toBeNull();
  });

  test("読めないマークアップは、カードを出さない（画面には断りのカードを出す）", () => {
    expect(chatUiPartOf(toolCall({ markup: "<Card><Nope /></Card>" }))?.view).toBeNull();
    expect(chatUiPartOf(toolCall({ markup: 42 }))?.view).toBeNull();
    expect(chatUiPartOf(toolCall(null))?.view).toBeNull();
    expect(chatUiPartOf(toolCall({ markup }))?.view).not.toBeNull();
  });

  test("選んだ選択肢のラベルを発言にする", () => {
    expect(choiceMessage(choice, [1])).toBe("B案");
    expect(choiceMessage({ ...choice, multiple: true }, [0, 1])).toBe("A案, B案");
    // 範囲外や空の選択は、送る文に残さない。
    expect(choiceMessage(choice, [5])).toBe("");
    expect(choiceMessage(choice, [])).toBe("");
  });

  test("フォームの入力を発言にする（空の任意欄は省く）", () => {
    expect(formMessage(form, { 0: "Tera", 3: true }, { yes: "はい", no: "いいえ" })).toBe("名前: Tera\n同意: はい");
    expect(formMessage(form, { 0: "Tera", 1: "3", 2: "Pro", 3: false }, { yes: "はい", no: "いいえ" })).toBe(
      "名前: Tera\n人数: 3\nプラン: Pro\n同意: いいえ",
    );
    expect(formMessage(form, {}, { yes: "はい", no: "いいえ" })).toBe("同意: いいえ");
  });

  test("必須の欄が埋まるまで送れない", () => {
    expect(formComplete(form, {})).toBe(false);
    expect(formComplete(form, { 0: "Tera" })).toBe(false);
    expect(formComplete(form, { 0: "Tera", 3: true })).toBe(true);
    // 空白だけは入力とみなさない。
    expect(formComplete(form, { 0: "  ", 3: true })).toBe(false);
  });
});

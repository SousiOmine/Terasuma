import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { createChatUiTools } from "../src/server/tools/ui";
import { UI_MARKUP_LIMITS } from "../src/shared/ui-markup";

/**
 * chat_ui ツール。
 * モデルを介さずに直接呼び、マークアップの検証とスキーマの境界を確かめる。
 */

function chatUi() {
  const definition = createChatUiTools()["chat_ui"];
  if (definition === undefined) throw new Error("chat_ui が無い");
  return definition;
}

async function callTool(markup: string): Promise<string> {
  const definition = chatUi();
  if (definition.execute === undefined) throw new Error("chat_ui の実行が無い");
  return (await definition.execute({ markup } as never, { toolCallId: "c1" } as never)) as string;
}

describe("chat_ui", () => {
  test("正しいマークアップを受け付け、表示したことを返す", async () => {
    const result = await callTool(
      '<Card title="確認"><Text>どれにしますか?</Text><Choice><Option>a</Option><Option>b</Option></Choice></Card>',
    );

    expect(result).toContain("The card is shown in the chat");
  });

  test("直せないマークアップは、行・桁と理由をつけて断る", async () => {
    await expect(callTool("<Card><Nope /></Card>")).rejects.toThrow("Invalid UI markup:");
    await expect(callTool("<Card><Nope /></Card>")).rejects.toThrow("<Nope> is not allowed inside <Card>");
    await expect(callTool("<Card><Text>a & b</Text></Card>")).rejects.toThrow("line 1");
  });

  test("スキーマは空・長すぎる・欠けた入力を弾く", async () => {
    const schema = asSchema(chatUi().inputSchema);
    if (schema.validate === undefined) throw new Error("chat_ui の検証が無い");

    expect(await schema.validate({ markup: "" })).toMatchObject({ success: false });
    expect(await schema.validate({ markup: "a".repeat(UI_MARKUP_LIMITS.chars + 1) })).toMatchObject({
      success: false,
    });
    expect(await schema.validate({})).toMatchObject({ success: false });
    expect(await schema.validate({ markup: "<Card><Text>a</Text></Card>" })).toMatchObject({ success: true });
  });
});

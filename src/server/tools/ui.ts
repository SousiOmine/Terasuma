import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { UI_TOOL_NAME } from "../../shared/tools";
import { parseUiMarkup, UI_MARKUP_LIMITS } from "../../shared/ui-markup";

/**
 * Tera がチャットへ UI（カード）を送るツール。
 *
 * 受け取るのは UI マークアップ 1 枚分の文字列だけで、ここでは解釈して確かめるだけ。
 * 描画はクライアントがツール呼び出しの引数から行う（新しい部品の種類や保存形式を増やさない）。
 * 押した選択肢は、待ちではなく新しいユーザー発言として戻ってくる。
 * そのため、このツールは待たずにすぐ「表示した」と返す。
 *
 * 説明文には語彙と例を載せる。モデルはツール一覧の説明だけで正しいマークアップを書ける。
 * 説明文に可変の情報は入れない（毎回のプロンプトキャッシュを外さないため）。
 */
export type ChatUiToolset = ToolSet;

const UI_TOOL_DESCRIPTION = [
  "Show a card in the chat: text, a list, a table, a flow chart, or a question with choices.",
  'markup is one <Card title="..."> with Text, List, Table, Flow, Choice and Form blocks inside it.',
  "<Text>paragraph</Text>; <List ordered><Item>one</Item></List>; <Table><Row><Cell>head</Cell><Cell>head</Cell></Row></Table> (the first row is the header).",
  '<Flow><Node id="a" shape="box|round|diamond|pill">Start</Node><Edge from="a" to="b" label="yes" dashed /></Flow>.',
  '<Choice multiple><Option description="why">Label</Option></Choice>; <Form submit="Send"><Field label="Name" type="text|number|select|checkbox" required placeholder="..."><Option>a choice for select</Option></Field></Form>.',
  "Use at most one Choice or Form per card. Write boolean attributes without a value, and attribute values in double quotes.",
  "Escape <, > and & in text as &lt;, &gt; and &amp;.",
  "Clicking an option sends its label as the user's next message; the user can click only after your turn ends. Do not repeat the same question in your text.",
].join(" ");

/** モデルへ渡すツール。キーはツール名（"chat_ui"）。 */
export function createChatUiTools(): ChatUiToolset {
  return {
    [UI_TOOL_NAME]: tool({
      description: UI_TOOL_DESCRIPTION,
      inputSchema: z.object({
        markup: z
          .string()
          .min(1)
          .max(UI_MARKUP_LIMITS.chars)
          .describe("One <Card> of UI markup, written with the tags named in the description"),
      }),
      execute: async ({ markup }: { markup: string }) => {
        const parsed = parseUiMarkup(markup);
        // 直せない書き方は、行・桁と理由をそのまま返す（モデルはそれを読んで書き直せる）。
        if (!parsed.ok) throw new Error(`Invalid UI markup: ${parsed.problem}`);
        return "The card is shown in the chat. When the user clicks an option, its label arrives as a new user message.";
      },
    }),
  };
}

import { asSchema, jsonSchema } from "ai";
import type { Schema, ToolSet } from "ai";
import { describeToolFailure } from "../tool-failure";

/**
 * 1 ターン分のツール一式の組み立て。
 *
 * 「どのツールを、どの範囲の Aent を目標に、どの順で組むか」をここにまとめる。
 * sdk.ts は、この一式を受け取って streamText へ渡すだけにする（呼び出しの設定と分ける）。
 *
 * ツールには 2 種類ある。
 * - モデルの一覧にそのまま載るもの（read / write / edit / bash / chat_attach / skill など）
 * - tool_search の向こう側に置くもの（MCP・computer_・connector・Discord・routine・tera・mcp_manage）
 *   名前と説明と引数スキーマが大きいので、使うときだけ取り寄せる。
 */

/**
 * 引数の検証で落ちたときの理由を、モデルが直せる短い文に置き換える。
 * AI SDK の既定の文は長く、モデルが読み飛ばして同じ呼び出しを繰り返すことがある。
 */
export async function withShortToolErrors(tools: ToolSet): Promise<ToolSet> {
  const wrapped: ToolSet = {};

  for (const [name, definition] of Object.entries(tools)) {
    const schema = asSchema(definition.inputSchema);
    const validate = schema.validate;
    if (validate === undefined) {
      wrapped[name] = definition;
      continue;
    }

    const shortSchema: Schema<unknown> = jsonSchema(await schema.jsonSchema, {
      validate: async (value) => {
        const result = await validate(value);
        return result.success ? result : { success: false, error: new Error(describeToolFailure(name, result.error)) };
      },
    });
    wrapped[name] = { ...definition, inputSchema: shortSchema };
  }

  return wrapped;
}

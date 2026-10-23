import type { CallToolResult } from "@modelcontextprotocol/client";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { describeError } from "../../shared/errors";
import { truncateText } from "../../shared/text";
import { toolNameFor } from "../../shared/tools";
import type { ImageRef } from "../../shared/api/message";
import type { ImageToolOutput } from "../agent/tool-output";
import type { ImageStore } from "../computer/images";
import type { McpServerSettings } from "../data/settings";
import type { ServerConnection } from "./connection";

/**
 * MCP の結果としてモデルへ渡す本文の上限（文字数）。
 * サーバーが巨大な出力を返しても、それがそのまま文脈を飲み込まないようにする。
 */
export const MAX_MCP_RESULT_CHARS = 50_000;

/**
 * MCP サーバーが公開しているツールを、モデルへ渡す形に変換する。
 * 名前は "<サーバー id>_<ツール名>" にし、サーバーをまたいだ衝突は呼び出し側が断る。
 */

export function toolEntries(
  serverId: string,
  connection: ServerConnection,
  images: ImageStore,
): [string, ToolSet[string]][] {
  return connection.tools.map((definition) => [
    toolNameFor(serverId, definition.name),
    tool({
      description: definition.description ?? "",
      inputSchema: jsonSchema(definition.inputSchema as unknown as JSONSchema7),
      execute: async (input: unknown, options: { abortSignal?: AbortSignal }) => {
        const result = await connection.client.callTool(
          { name: definition.name, arguments: asArguments(input) },
          options.abortSignal === undefined ? {} : { signal: options.abortSignal },
        );

        const output = callToolOutput(result, images);
        // エラーは例外にして、モデルへ本文だけを渡す（JSON の包装を見せない）。
        if (result.isError === true) throw new Error(output.text);
        return output;
      },
    }),
  ]);
}

/** ツールの入力は必ずオブジェクト。壊れた形は空として扱い、サーバー側の検証に任せる。 */
function asArguments(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

/**
 * MCP の結果から、モデルへ渡す本文と画像を取り出す。
 * 画像は置き場に保存し、会話とモデルへは参照だけを渡す（base64 を載せない）。
 */
function callToolOutput(result: CallToolResult, images: ImageStore): ImageToolOutput {
  const texts: string[] = [];
  const refs: ImageRef[] = [];

  for (const block of result.content) {
    if (block.type === "text") {
      texts.push(block.text);
      continue;
    }
    if (block.type !== "image") continue;

    try {
      refs.push(images.save(Buffer.from(block.data, "base64"), block.mimeType));
    } catch (error) {
      // 扱えない形式や壊れた中身でも、他の内容は読めるようにする。
      texts.push(`(Could not store the image returned by the tool: ${describeError(error)})`);
    }
  }

  if (texts.length > 0) {
    return {
      text: truncateText(texts.join("\n"), MAX_MCP_RESULT_CHARS, "brackets"),
      ...(refs.length === 0 ? {} : { images: refs }),
    };
  }

  if (refs.length > 0) {
    return {
      text: refs.length === 1 ? "(image returned by the tool)" : `(${refs.length} images returned by the tool)`,
      images: refs,
    };
  }

  // テキストも画像も無い（資源や音声だけ）場合は、結果全体を JSON として見せる。
  return { text: JSON.stringify(result) };
}

/**
 * 同じ接続先を確かめているかどうか。
 * 設定はどちらも入力から組み立てたものなので、項目の並びまで同じになる。
 */
export function sameServer(left: McpServerSettings, right: McpServerSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 名前（id）の規則。
 *
 * プロバイダ id はモデル ID の先頭、MCP サーバー id はツール名の先頭になる。
 * どちらも設定ファイルの検証と、画面の入力の検証で同じ規則を使う。
 * 片方だけを直すと「画面では通るのに保存できない」状態になるため、ここに 1 つだけ置く。
 */

import {
  APP_SERVER_ID,
  CHAT_SERVER_ID,
  COMPUTER_SERVER_ID,
  HISTORY_SERVER_ID,
  SKILL_SERVER_ID,
  TOOL_SERVER_ID,
  WEB_SERVER_ID,
} from "./tools";

/** id に使える文字。AI へ渡す名前の先頭部分になるため、記号と空白は許さない。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * MCP サーバーの id に使えない名前。
 * ツール名は "<サーバー id>_<ツール名>" になるので、内蔵ツール（"computer_..."、"chat_..."、
 * "tool_..."、"history_..."、"web_..."、"skill_..."、"app_..."）と同じ名前が作れてしまう。
 * 同じ名前になると、どちらのツールかモデルにも画面にも区別が付かない。
 */
export const RESERVED_MCP_SERVER_IDS: readonly string[] = [
  COMPUTER_SERVER_ID,
  CHAT_SERVER_ID,
  TOOL_SERVER_ID,
  HISTORY_SERVER_ID,
  WEB_SERVER_ID,
  SKILL_SERVER_ID,
  APP_SERVER_ID,
];

/** MCP サーバー id の受け付けられない理由。使える場合は null。 */
export type McpServerIdProblem = "reserved" | "invalid";

/** プロバイダ id として使えるかどうか。 */
export function isProviderId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** MCP サーバー id を受け付けられない理由。使える場合は null。 */
export function mcpServerIdProblem(value: string): McpServerIdProblem | null {
  if (RESERVED_MCP_SERVER_IDS.includes(value)) return "reserved";
  if (!ID_PATTERN.test(value)) return "invalid";
  return null;
}

/** MCP サーバー id として使えるかどうか。 */
export function isValidMcpServerId(value: string): boolean {
  return mcpServerIdProblem(value) === null;
}

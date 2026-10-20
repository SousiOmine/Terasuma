/**
 * ツール名の規約。
 *
 * モデルへ渡すツール名は "<サーバー id>_<ツール名>" の 1 つの形にする。
 * MCP サーバーのツールも、Terasuma の内蔵ツール（computer_...）も同じ名前空間に並ぶ。
 * 組み立てる場所と分解する場所が離れると規則がずれるので、ここだけに置く。
 *
 * サーバー id には "_" を使えない（shared/ids.ts で弾いている）。
 * そのため分解は最初の "_" で必ず確定する。
 */

/** サーバー id とツール名の区切り。 */
export const TOOL_NAME_SEPARATOR = "_";

/** 内蔵のコンピュータ操作ツールのサーバー id。MCP サーバーの id としては使えない。 */
export const COMPUTER_SERVER_ID = "computer";

/** 画面をユーザーへ渡すツール名（サーバー id を付けない形）。 */
export const ASK_USER_TOOL = "ask_user";

/** モデルへ渡すときの、画面を渡すツールの名前。 */
export const ASK_USER_TOOL_NAME = `${COMPUTER_SERVER_ID}${TOOL_NAME_SEPARATOR}${ASK_USER_TOOL}`;

/** サーバー id とツール名から、モデルへ渡す名前を組み立てる。 */
export function toolNameFor(server: string, tool: string): string {
  return server.length === 0 ? tool : `${server}${TOOL_NAME_SEPARATOR}${tool}`;
}

/**
 * モデルへ渡す名前を、サーバー id とツール名に分ける。
 * 区切りが無い名前は、内蔵ツール（サーバーを持たない）として扱う。
 */
export function splitToolName(name: string): { server: string; tool: string } {
  const boundary = name.indexOf(TOOL_NAME_SEPARATOR);
  if (boundary === -1) return { server: "", tool: name };
  return { server: name.slice(0, boundary), tool: name.slice(boundary + 1) };
}

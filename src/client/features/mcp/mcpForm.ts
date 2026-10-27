import { isEnvName } from "../../../shared/env";
import { mcpServerIdProblem } from "../../../shared/ids";
import type { McpServerForm } from "../../../shared/api/settings";
import type { MessageKey } from "../../i18n";

/**
 * MCP サーバー追加ダイアログの純粋な部分。
 *
 * 入力（すべて文字列）を送れる形へ直し、読めなければ理由を返す。
 * 文言の解決は呼び出し側が行うので、ここは DOM も i18n の状態も要らない。
 */

/** ダイアログの入力。すべて文字列で持つ（textarea の値をそのまま受け取るため）。 */
export type McpFormFields = {
  id: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  url: string;
};

/** 入力の検証結果。読めなかった理由は文言のキーで返す。 */
export type McpFormResult = { kind: "ok"; form: McpServerForm } | { kind: "error"; message: MessageKey };

/** 入力を検証して送れる形にする。 */
export function buildForm(fields: McpFormFields, takenIds: readonly string[]): McpFormResult {
  const id = fields.id.trim();
  const idProblem = mcpServerIdProblem(id);
  if (idProblem !== null) {
    return {
      kind: "error",
      message: idProblem === "reserved" ? "settings.mcp.form.reservedName" : "settings.mcp.form.invalidName",
    };
  }

  // 同じ id は設定でもツール名でも衝突する。サーバー側でも弾くが、繋ぎに行く前にここで止める。
  if (takenIds.includes(id)) return { kind: "error", message: "settings.mcp.form.nameTaken" };

  if (fields.type === "stdio") {
    const command = fields.command.trim();
    if (command.length === 0) return { kind: "error", message: "settings.mcp.form.needCommand" };

    const env = parseEnv(fields.env);
    if (env === null) return { kind: "error", message: "settings.mcp.form.invalidEnv" };

    return { kind: "ok", form: { id, type: "stdio", command, args: lines(fields.args), env, url: null } };
  }

  const url = fields.url.trim();
  if (url.length === 0) return { kind: "error", message: "settings.mcp.form.needUrl" };

  return { kind: "ok", form: { id, type: "http", command: null, args: null, env: null, url } };
}

/** 1 行 1 項目の入力を、空行を除いた配列にする。 */
export function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** KEY=VALUE を 1 行ずつ読む。読めない行があれば null。 */
export function parseEnv(value: string): Record<string, string> | null {
  const variables: Record<string, string> = {};

  for (const line of lines(value)) {
    const separator = line.indexOf("=");
    if (separator <= 0) return null;

    const name = line.slice(0, separator).trim();
    if (!isEnvName(name)) return null;
    variables[name] = line.slice(separator + 1).trim();
  }
  return variables;
}

/** 対応表を、textarea に出す KEY=VALUE の並びにする。 */
export function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

import { describeError } from "../../shared/errors";
import { recordOf } from "../../shared/guards";

/** モデルへ返す失敗の本文の上限。 */
const MAX_FAILURE_CHARS = 300;

/** 引数の失敗で並べる issue の数。 */
const MAX_ISSUES = 3;

/** 1 つの issue の message の上限。 */
const MAX_ISSUE_MESSAGE_CHARS = 80;

/** 引数の検証以外の失敗で使う、最初の行の上限。 */
const MAX_REASON_CHARS = 240;

/** ツールの失敗を、モデルがそのまま次の呼び出しに使える短い 1〜2 文にする。 */
export function describeToolFailure(toolName: string, error: unknown): string {
  const reason = firstLine(error);

  // 呼び出し元が既に同じ形にしているときは、前置きを重ねない。
  if (reason.startsWith("Invalid arguments for")) return truncate(reason, MAX_FAILURE_CHARS);

  const issues = describeIssues(error);

  if (issues !== null || isValidationFailure(reason)) {
    return truncate(
      `Invalid arguments for "${toolName}": ${issues ?? reason}. Call tool_search("${toolName}") to see the arguments, then call tool_call again.`,
      MAX_FAILURE_CHARS,
    );
  }

  if (isMissingTool(error, reason)) {
    return truncate(
      `No tool named "${toolName}". Use tool_search to find the name, then call it with tool_call.`,
      MAX_FAILURE_CHARS,
    );
  }

  const message = reason.length === 0 ? "The tool failed without a message." : truncate(reason, MAX_REASON_CHARS);
  return truncate(message, MAX_FAILURE_CHARS);
}

/** 検証の失敗から、`<path>: <message>` を `;` でつないだ要約を取り出す。取り出せなければ null。 */
export function describeIssues(error: unknown): string | null {
  const issues = issuesOf(error);
  if (issues === null) return null;

  const parts: string[] = [];
  for (const issue of issues.slice(0, MAX_ISSUES)) {
    const described = describeIssue(issue);
    if (described !== null) parts.push(described);
  }
  return parts.length === 0 ? null : parts.join("; ");
}

/** `error.issues`、`error.cause.issues`、`error.cause.cause.issues` を順に見る。 */
function issuesOf(error: unknown): readonly unknown[] | null {
  let current: unknown = error;

  for (let depth = 0; depth < 3; depth += 1) {
    const record = recordOf(current);
    if (record === null) return null;

    const issues = record["issues"];
    if (Array.isArray(issues)) return issues;
    current = record["cause"];
  }
  return null;
}

/** 1 つの issue を、パス付きの短い 1 行にする。 */
function describeIssue(issue: unknown): string | null {
  const record = recordOf(issue);
  if (record === null) return null;

  const raw = typeof record["message"] === "string" ? record["message"] : "";
  const message = truncate(raw.split("\n")[0]?.trim() ?? "", MAX_ISSUE_MESSAGE_CHARS);
  const path = issuePath(record["path"]);

  if (message.length === 0) return path.length === 0 ? "invalid value" : `${path}: invalid value`;
  return path.length === 0 ? message : `${path}: ${message}`;
}

/** issue の path を、`.` でつないだ名前にする。 */
function issuePath(value: unknown): string {
  if (!Array.isArray(value)) return "";

  return value
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .map((part) => String(part))
    .join(".");
}

/** 例外から、接頭辞を落とした最初の行を取り出す。 */
function firstLine(error: unknown): string {
  const text = stripErrorPrefixes(describeError(error));
  return text.split("\n")[0]?.trim() ?? "";
}

/** `AI_...Error: ` と、先頭の `Error: ` の接頭辞を、残らなくなるまで落とす。 */
function stripErrorPrefixes(text: string): string {
  let current = text;

  for (;;) {
    const next = current.replace(/AI_[A-Za-z0-9_]*Error:\s*/g, "").replace(/^Error:\s*/, "");
    if (next === current) return current;
    current = next;
  }
}

/** 引数の検証で失敗したことを、例外の種類か文面から判断する。 */
function isValidationFailure(reason: string): boolean {
  return reason.includes("Invalid input for tool") || reason.includes("Type validation failed");
}

/** ツールが見つからなかった失敗かどうか。 */
function isMissingTool(error: unknown, reason: string): boolean {
  if (error instanceof Error && error.name.includes("NoSuchToolError")) return true;
  return reason.includes("Unknown tool");
}

/** 文字列を上限までに切る。 */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

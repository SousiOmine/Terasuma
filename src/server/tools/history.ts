import { recordOf } from "../../shared/guards";
import { formatLocalDate, truncateText } from "../../shared/text";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { HISTORY_SEARCH_TOOL_NAME, TOOL_CALL_TOOL, TOOL_SERVER_ID, toolNameFor } from "../../shared/tools";
import type { ChatMessage, MessagePart } from "../../shared/api/message";
import type { Store } from "../data/store";
import type { HistoryToolsetProvider } from "../agent/contracts";
import { clampInt } from "../../shared/numbers";
import { cleanDay, dayRange } from "./history-date";

/**
 * 過去の対話履歴を検索する内蔵ツール（history_search）。
 *
 * Tera へ渡す文脈は「畳んだ要約 + まだ畳んでいない直近の履歴」だけなので、圧縮で文脈から外れた
 * 古いやり取りはモデルから見えない。生のメッセージは DB に残っているので、ここから
 * 検索語（正規表現）・期間・件数を指定して引けるようにする。
 *
 * 結果にツール呼び出しを載せるときは、呼ばれたツールの名前だけにする。引数や結果まで戻すと、
 * 過去の大きな出力で結果が膨らみ、読みたい本文が埋もれる（モデルにも余計な文脈を払わせる）。
 */

export type HistoryToolset = ToolSet;

/** 1 回の検索で返す件数。 */
export const DEFAULT_HISTORY_LIMIT = 10;

/** 1 回の検索で返せる件数の上限。 */
export const MAX_HISTORY_LIMIT = 100;

/** 1 件のメッセージに載せる本文の上限（文字数）。 */
const MAX_TEXT_CHARS = 1_000;

/** 結果全体の本文の上限（文字数）。件数の上限だけでは、結果の大きさを抑えられない。 */
const MAX_RESULT_CHARS = 40_000;

/** 見出しに書く検索語の上限（文字数）。 */
const MAX_QUERY_CHARS = 200;

/** 1 つの検索語（正規表現）の上限（文字数）。長すぎるパターンは、探す費用が読めない。 */
const MAX_PATTERN_CHARS = 500;
/**
 * 1 件の本文で、正規表現をかける長さの上限。
 * 検索は本文の全体像を探すものなので、溢れた分は切ってから照合する（計算量を有界にする）。
 */
const MAX_SEARCH_TEXT_CHARS = 200_000;

/** 添付名を並べる数の上限。 */
const MAX_ATTACHMENT_NAMES = 5;

/** 空白（全角を含む）。 */
const WHITESPACE = /[\s\u3000]+/u;

export type CreateHistoryToolsetOptions = {
  store: Store;
};

/**
 * 履歴検索のツールの供給元。
 * 引く履歴はターンの対象の Tera のものなので、ターンのたびに teraId を受け取る。
 */
export function createHistoryToolset({ store }: CreateHistoryToolsetOptions): HistoryToolsetProvider {
  return {
    toolset: ({ teraId }) => createHistoryTools({ store, teraId }),
  };
}

export type HistoryToolsOptions = {
  store: Store;
  /** 引く履歴の持ち主。 */
  teraId: string;
};

/** モデルへ渡す履歴検索のツール。キーはツール名（"history_search"）。 */
export function createHistoryTools({ store, teraId }: HistoryToolsOptions): HistoryToolset {
  return {
    [HISTORY_SEARCH_TOOL_NAME]: tool({
      description: [
        "Search your past conversation with the user, including turns that were compacted out of your visible history.",
        "Each whitespace-separated term is a JavaScript regular expression, matched case-insensitively; a message matches only when every term matches it.",
        "Escape metacharacters to match them literally (for example C\\+\\+ for C++).",
        "invert returns the messages that do not match (grep -v) and needs a query; wholeWord requires each match to be a whole word (grep -w).",
        "from and to take YYYY-MM-DD dates in local time and are inclusive; omit them for no bound on that side.",
        "Returns the newest matching messages. Omit the query to list what happened in a period.",
      ].join(" "),
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Words or regular expressions to look for. Every term must match the message."),
        invert: z
          .boolean()
          .optional()
          .describe("Return the messages that do not match the query (grep -v). Needs a query."),
        wholeWord: z.boolean().optional().describe("Require each term to match a whole word (grep -w)."),
        from: z.string().optional().describe("Start date, YYYY-MM-DD in local time (inclusive)."),
        to: z.string().optional().describe("End date, YYYY-MM-DD in local time (inclusive)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_HISTORY_LIMIT)
          .optional()
          .describe(
            `How many of the newest matching messages to return (default ${DEFAULT_HISTORY_LIMIT}, max ${MAX_HISTORY_LIMIT}).`,
          ),
      }),
      execute: async ({
        query,
        from,
        to,
        limit,
        invert,
        wholeWord,
      }: {
        query?: string;
        from?: string;
        to?: string;
        limit?: number;
        invert?: boolean;
        wholeWord?: boolean;
      }) => search({ store, teraId, query, from, to, limit, invert, wholeWord }),
    }),
  };
}

type SearchInput = {
  store: Store;
  teraId: string;
  query: string | undefined;
  from: string | undefined;
  to: string | undefined;
  limit: number | undefined;
  invert: boolean | undefined;
  wholeWord: boolean | undefined;
};

/** 検索して、モデルが読む本文を組み立てる。 */
function search({ store, teraId, query, from, to, limit, invert, wholeWord }: SearchInput): string {
  const range = dayRange(from, to);
  const terms = termsOf(query ?? "");
  const excluded = invert === true;
  if (excluded && terms.length === 0) {
    throw new Error("invert needs a query: pass the words or regular expressions to exclude.");
  }

  const patterns = terms.map((term) => patternOf(term, wholeWord === true));
  const messages = store.listMessagesBetween(teraId, range);
  const matches =
    terms.length === 0 ? messages : messages.filter((message) => containsAll(message, patterns) !== excluded);

  const scope = describeQuery(query ?? "", { invert: excluded, wholeWord: wholeWord === true });
  const period = describePeriod(from, to);
  if (matches.length === 0) return noMatchText(scope, period, messages.length);

  const max = clampLimit(limit);
  const newest = matches.slice(-max);

  // 新しい方から積む。件数だけでは結果の大きさを抑えられないので、文字数でも切る。
  const rendered: string[] = [];
  let used = 0;
  for (let index = newest.length - 1; index >= 0; index -= 1) {
    const message = newest[index];
    if (message === undefined) continue;

    const text = formatMessage(message);
    if (rendered.length > 0 && used + text.length > MAX_RESULT_CHARS) break;
    rendered.unshift(text);
    used += text.length;
  }

  const lines = [`Found ${matches.length} message(s)${scope}${period}.`];
  if (rendered.length < Math.min(matches.length, max)) {
    lines.push(
      `Showing the newest ${rendered.length}; a search returns at most ${MAX_RESULT_CHARS} characters. ` +
        "Narrow the period or use fewer words to see the rest.",
    );
  } else if (matches.length > max) {
    lines.push(
      `Showing the newest ${rendered.length}; raise limit (max ${MAX_HISTORY_LIMIT}) or narrow the period to see the rest.`,
    );
  }
  lines.push("", rendered.join("\n\n"));
  return lines.join("\n");
}

/** 1 件も当たらなかったときの本文。期間内の件数は、語を変える手がかりになる。 */
function noMatchText(scope: string, period: string, inRange: number): string {
  if (inRange === 0) {
    return period === "" ? "No messages have been saved for this conversation yet." : `No messages exist${period}.`;
  }

  return [
    `No message${scope}${period}.`,
    period === "" ? `${inRange} message(s) exist in the history.` : `${inRange} message(s) exist${period}.`,
    "Try fewer words, a wider period, or omit the query to list what happened.",
  ].join(" ");
}

/** 検索語を空白で分ける。日本語は語の区切りが無いので、そのまま 1 つの語として扱う。 */
function termsOf(query: string): string[] {
  return query.split(WHITESPACE).filter((term) => term.length > 0);
}

/**
 * すべての語の正規表現が当たるかどうか。
 *
 * 照合する前に本文を上限で切る。長い本文をまるごと正規表現にかけると、
 * 破滅的な後戻りをする検索語（(a+)+$ など）で 1 件あたりの計算量が跳ね上がる。
 * 切った分は検索の対象から外れるが、切り詰めたことは結果の本文にも残している。
 */
function containsAll(message: ChatMessage, patterns: readonly RegExp[]): boolean {
  const text = truncateText(searchableText(message), MAX_SEARCH_TEXT_CHARS, "marked");
  return patterns.every((pattern) => pattern.test(text));
}

/**
 * 検索語を、大文字小文字を無視する正規表現にする。
 * wholeWord は、当たった箇所の前後が文字（Unicode の英数字と _）でないことを要求する（grep -w）。
 */
function patternOf(term: string, wholeWord: boolean): RegExp {
  if (term.length > MAX_PATTERN_CHARS) {
    throw new Error(`A query term is too long (max ${MAX_PATTERN_CHARS} characters).`);
  }
  if (!wholeWord) return compilePattern(term, term);

  // 素の形でも壊れていないかを先に見る（壊れていれば、その理由を返す）。
  compilePattern(term, term);
  return compilePattern(`(?<![\\p{L}\\p{N}_])(?:${term})(?![\\p{L}\\p{N}_])`, term);
}

/**
 * 入れ子の量指定子（(a+)+ や (a*)* など）を含むかどうか。
 *
 * この形は、当たらない入力に対して後戻りが指数的に増える（ReDoS）。
 * 検索語はモデルが作るので、危険な形は組み立てる前に断る。
 * 完全な判定ではないが、実際に問題になる形の多くはここで止まる。
 */
function hasNestedQuantifier(source: string): boolean {
  return /\([^()]*[+*][^()]*\)\s*[+*{]/.test(source);
}

/** 正規表現を組み立てる。壊れていれば、直し方の分かる理由で止める。 */
function compilePattern(source: string, term: string): RegExp {
  if (hasNestedQuantifier(source)) {
    throw new Error(
      `Query term "${term}" repeats a group that already repeats ((a+)+ and similar). ` +
        "Rewrite it so the match does not have to backtrack.",
    );
  }

  try {
    return new RegExp(source, "iu");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Query term "${term}" is not a valid regular expression: ${reason}. ` +
        "Escape metacharacters to match them literally (for example C\\+\\+ for C++).",
    );
  }
}

/**
 * そのメッセージから検索する本文。
 * ツールの結果と注記は含めない（過去の大きな出力で、読みたい本文が埋もれるため）。
 */
function searchableText(message: ChatMessage): string {
  if (message.role === "user") {
    return [message.content, ...attachmentNames(message)].join("\n");
  }

  const parts = message.parts ?? [];
  const text = parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n");
  return [text, ...calledNames(parts)].join("\n");
}

function attachmentNames(message: ChatMessage): string[] {
  return (message.attachments ?? []).map((file) => file.name);
}

/** そのメッセージで呼ばれたツールの名前（呼ばれた順、重複なし）。 */
function calledNames(parts: readonly MessagePart[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.type !== "tool-call") continue;

    const name = calledToolName(part);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * 呼び出しの名前。tool_call は他のツールを名前で呼ぶだけの入口なので、引数の name
 * （実際に動いたツール）を名前にする。読めないときだけ "tool_call" にする。
 */
function calledToolName(part: Extract<MessagePart, { type: "tool-call" }>): string {
  if (part.server === TOOL_SERVER_ID && part.tool === TOOL_CALL_TOOL) {
    const target = recordOf(part.args)?.["name"];
    if (typeof target === "string" && target.length > 0) return target;
  }
  return toolNameFor(part.server, part.tool);
}

function isTextPart(part: MessagePart): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text";
}

/** 1 件分。見出し（時刻と役割）と本文。 */
function formatMessage(message: ChatMessage): string {
  return `[${formatLocalDate(message.createdAt, { time: true })}] ${message.role}\n${truncateText(bodyOf(message), MAX_TEXT_CHARS, "parens")}`;
}

/** 画面に出る本文と、添付名・ツール名の注記。 */
function bodyOf(message: ChatMessage): string {
  if (message.role === "user") {
    const lines: string[] = [];
    if (message.content.trim().length > 0) lines.push(message.content);

    const names = attachmentNames(message);
    if (names.length > 0) lines.push(`(attached: ${nameList(names)})`);
    return lines.length === 0 ? "(no text)" : lines.join("\n");
  }

  const parts = message.parts ?? [];
  const text = parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();

  const lines: string[] = [];
  if (text.length > 0) lines.push(text);

  const names = calledNames(parts);
  if (names.length > 0) lines.push(`(tool calls: ${names.join(", ")})`);
  return lines.length === 0 ? "(no text)" : lines.join("\n");
}

/** 添付名の並び。多すぎるときは、省いた数を添える。 */
function nameList(names: readonly string[]): string {
  if (names.length <= MAX_ATTACHMENT_NAMES) return names.join(", ");
  return `${names.slice(0, MAX_ATTACHMENT_NAMES).join(", ")} (+${names.length - MAX_ATTACHMENT_NAMES} more)`;
}

/** 件数を、受け付ける範囲に収める。 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HISTORY_LIMIT;
  return clampInt(limit, 1, MAX_HISTORY_LIMIT);
}

/** 見出しに書く検索語と、指定された grep のフラグ。 */
function describeQuery(query: string, options: { invert: boolean; wholeWord: boolean }): string {
  const text = query.trim();
  if (text.length === 0) return "";

  const shown = text.length <= MAX_QUERY_CHARS ? text : `${text.slice(0, MAX_QUERY_CHARS)}…`;
  const words = options.wholeWord ? " (whole words only)" : "";
  return `${options.invert ? " not matching" : " matching"} "${shown}"${words}`;
}

/** 期間の説明。端が無ければ、その端を書かない。 */
function describePeriod(from: string | undefined, to: string | undefined): string {
  const start = cleanDay(from);
  const end = cleanDay(to);
  if (start === null && end === null) return "";
  if (start !== null && end === null) return ` since ${start} (local time)`;
  if (start === null && end !== null) return ` until ${end} (local time)`;
  if (start === end) return ` on ${start} (local time)`;
  return ` from ${start} to ${end} (local time)`;
}

import { describeError } from "../shared/errors";
import type { ChatMessage, MessagePart } from "../shared/types";
import type { AgentEngine } from "./engine";
import { summaryText, toolNameFor, type TeraContext } from "./prompt";
import type { CompactionState, Store } from "./store";

/**
 * 過去の対話の圧縮（Compaction）。
 *
 * 会話が長くなっても、モデルへ渡す文脈を有界に保つための仕組み。
 * pi-coding-agent の compaction と同じ考え方で、こちらで組み立てている。
 *
 * - 文脈が文脈長に近づいたら、古いやり取りを定型の要約へ畳む
 * - 直近は生のまま残す（続きを細かい言い回しまで見せるため）
 * - 要約は「前の要約 + 新しいやり取り」を書き直す形で更新する
 *
 * 畳み始めるのは、次のどちらか。どちらも会話には割り込まない。
 *
 * 1. 文脈が文脈長の余白を引いた線を超えたとき。次のターンが上限に当たる前に場所を空ける。
 * 2. 最後のやり取りから 3 時間たったとき。放置中に畳んでおき、次の会話が始まったときに待たせない。
 *
 * 要約は先頭の user メッセージとして渡す（prompt.ts）。
 * 要約が変わらない限り前置きは前のターンと一致するので、プロンプトキャッシュは当たり続ける。
 */

/** 最後のやり取りからこれだけたったら、閾値に関係なく畳む。 */
const IDLE_MS = 3 * 60 * 60 * 1000;

/** 文脈長が分からないモデルの見積もり（接続先を自分で決めたモデルなど）。 */
const DEFAULT_CONTEXT_TOKENS = 128_000;

/** 返事のために空けておくトークン。pi と同じ既定値。 */
const RESERVE_TOKENS = 16_384;

/** 直近は生のまま残す量。pi と同じ既定値。 */
const KEEP_RECENT_TOKENS = 20_000;

/** 1 回の要約呼び出しに載せる会話の量（文脈長に対する割合）。前の要約も同じ呼び出しに載る。 */
const CHUNK_SHARE = 0.5;

/** 要約の出力の上限（余白に対する割合）。要約が際限なく長くならないようにする。 */
const SUMMARY_MAX_TOKENS = Math.floor(RESERVE_TOKENS * 0.8);

/** ターン前半の要約の出力の上限。 */
const PREFIX_MAX_TOKENS = Math.floor(RESERVE_TOKENS * 0.5);

/** 要約に見せるツールの結果 1 件の上限。長い出力で呼び出しが膨らむのを防ぐ。 */
const TOOL_RESULT_MAX_CHARS = 2_000;

/** 画像 1 枚の目安。実際の消費は大きさとプロバイダで変わるが、数える対象があることは忘れない。 */
const IMAGE_TOKENS = 1_000;

/** 1 回の更新の上限。過ぎたら打ち切る（続きは次の更新で進む）。 */
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

export type Compaction = {
  /**
   * モデルへ渡す文脈（要約と、まだ畳んでいない生の履歴）。
   * 同じ Tera の圧縮が走っていれば、終わるまで待つ。ターンの signal が立ったら待つのをやめる
   * （圧縮そのものは背景で続く）。
   */
  context(teraId: string, signal: AbortSignal): Promise<TeraContext>;
  /** ターンが終わったあとに呼ぶ。閾値を超えていれば始め、要らなければ 3 時間後に予約する。 */
  check(teraId: string): void;
  /** いま畳む（予約からもテストからも呼ぶ）。同じ Tera で重ねて走らせない。 */
  update(teraId: string, options?: { force?: boolean }): Promise<void>;
  /** 予約を片付ける。 */
  close(): void;
};

export type CreateCompactionOptions = {
  store: Store;
  /** 要約に使う呼び出し（ツールを使わない 1 回の生成）。 */
  engine: Pick<AgentEngine, "complete">;
  /** 失敗を端末へ出す口。会話は止めないが、黙らない。 */
  log: (message: string) => void;
  /** 既定のモデルの文脈長（トークン）。分からなければ null。 */
  contextLimit: () => number | null;
  /** 時刻。テストで差し替える。 */
  now?: () => number;
};

export function createCompaction(options: CreateCompactionOptions): Compaction {
  const { store, engine, log, contextLimit } = options;
  const now = options.now ?? Date.now;
  /** 走っている更新。同じ Tera で 2 つ重ねないための 1 箇所。 */
  const running = new Map<string, Promise<void>>();
  /** 3 時間後の予約。ターンのたびに引き直す。 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 文脈長。分からないモデルは既定値で見積もる。 */
  function limitTokens(): number {
    return contextLimit() ?? DEFAULT_CONTEXT_TOKENS;
  }

  /** 閾値。これを超えたら畳む。 */
  function threshold(): number {
    return limitTokens() - RESERVE_TOKENS;
  }

  /**
   * 直近として生のまま残す量。
   * 使える文脈（文脈長から余白を引いた分）の半分を上限にする。
   * 小さい文脈のモデルで、畳んだ直後にまた畳む（毎ターン要約を呼ぶ）状態を避けるため。
   */
  function keepRecentTokens(): number {
    return Math.max(1, Math.min(KEEP_RECENT_TOKENS, Math.floor(threshold() * 0.5)));
  }

  function check(teraId: string): void {
    cancel(teraId);

    const state = store.readCompaction(teraId);
    const pending = store.listMessagesSince(teraId, state.throughSeq);
    if (pending.length === 0) return;

    if (contextTokens(state, pending) > threshold()) {
      void update(teraId);
      return;
    }

    // それ以外は、最後のやり取りから 3 時間たつまで待つ。
    const last = pending[pending.length - 1];
    if (last === undefined) return;
    const at = last.createdAt + IDLE_MS;
    timers.set(
      teraId,
      setTimeout(
        () => {
          timers.delete(teraId);
          void update(teraId, { force: true });
        },
        Math.max(0, at - now()),
      ),
    );
  }

  function cancel(teraId: string): void {
    const timer = timers.get(teraId);
    if (timer === undefined) return;

    clearTimeout(timer);
    timers.delete(teraId);
  }

  function update(teraId: string, options: { force?: boolean } = {}): Promise<void> {
    const current = running.get(teraId);
    if (current !== undefined) return current;

    const job = run(teraId, options.force === true).finally(() => running.delete(teraId));
    running.set(teraId, job);
    return job;
  }

  async function run(teraId: string, force: boolean): Promise<void> {
    // 更新そのものに期限を置く（長い履歴でも、1 回で際限なく呼び続けない）。
    const signal = AbortSignal.timeout(UPDATE_TIMEOUT_MS);

    try {
      await compact(teraId, force, signal);
    } catch (error) {
      // 畳めなくても、畳んでいないやり取りは生のままモデルへ渡る（内容は失われない）。
      // ただし黙って続けない。理由を端末へ出す。
      log(`  圧縮: 畳めませんでした（${teraId}） ${describeError(error)}`);
    }
  }

  async function compact(teraId: string, force: boolean, signal: AbortSignal): Promise<void> {
    const state = store.readCompaction(teraId);
    const messages = store.listMessagesSince(teraId, state.throughSeq);
    if (messages.length === 0) return;

    const tokensBefore = contextTokens(state, messages);
    if (!force && tokensBefore <= threshold()) return;

    const cut = findCutPoint(messages, keepRecentTokens());
    // 全部が直近の分に収まっている。畳むものが無いので、呼び出しもしない。
    if (cut.firstKept <= 0) return;

    const historyEnd = cut.isSplitTurn ? cut.turnStart : cut.firstKept;
    const history = messages.slice(0, historyEnd);
    const prefix = cut.isSplitTurn ? messages.slice(cut.turnStart, cut.firstKept) : [];
    if (history.length === 0 && prefix.length === 0) return;

    const chunkTokens = Math.max(1, Math.floor(limitTokens() * CHUNK_SHARE));

    // 履歴とターン前半は互いに独立なので、同時に要約する。
    const [historySummary, prefixSummary] = await Promise.all([
      fold(teraId, history, state, chunkTokens, signal, tokensBefore),
      prefix.length === 0 ? Promise.resolve("") : summarizePrefix(prefix, signal),
    ]);

    const summary =
      prefixSummary === ""
        ? historySummary
        : `${historySummary === "" ? "No prior history." : historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixSummary}`;

    // 要約が覆うのは、生のまま残す範囲の手前まで。
    const lastFolded = messages[cut.firstKept - 1];
    if (lastFolded === undefined) throw new Error("畳む範囲の末尾を決められませんでした");

    store.writeCompaction(teraId, {
      summary,
      throughSeq: lastFolded.seq,
      tokensBefore,
      createdAt: now(),
    });

    log(
      `  圧縮: 古いやり取り ${cut.firstKept} 件を要約しました（${teraId}）` +
        ` 畳む前 ${tokensBefore} トークン、要約 ${summary.length} 文字`,
    );
  }

  /**
   * 会話を古い方から少しずつ要約へ畳み込む。
   * 1 回の呼び出しに載せる量を区切るのは、既存の長い履歴でも文脈長を超えないようにするため。
   * 1 区切りごとに保存するので、途中で打ち切られても進んだ分は残る。
   */
  async function fold(
    teraId: string,
    messages: readonly ChatMessage[],
    state: CompactionState,
    chunkTokens: number,
    signal: AbortSignal,
    tokensBefore: number,
  ): Promise<string> {
    let summary = state.summary;
    let rest = messages;

    while (rest.length > 0) {
      const chunk = takeChunk(rest, chunkTokens);
      const last = chunk[chunk.length - 1];
      if (last === undefined) break;

      summary = await summarize(conversationPrompt(chunk, summary), SUMMARY_MAX_TOKENS, signal);
      rest = rest.slice(chunk.length);

      store.writeCompaction(teraId, {
        summary,
        throughSeq: last.seq,
        tokensBefore,
        createdAt: now(),
      });
    }

    return summary;
  }

  async function summarizePrefix(messages: readonly ChatMessage[], signal: AbortSignal): Promise<string> {
    const prompt = [`<conversation>\n${serializeConversation(messages)}\n</conversation>`, TURN_PREFIX_PROMPT].join(
      "\n\n",
    );
    return summarize(prompt, PREFIX_MAX_TOKENS, signal);
  }

  /** ツールを使わない 1 回の生成。結果が要約として使えるかを確かめてから返す。 */
  async function summarize(prompt: string, maxOutputTokens: number, signal: AbortSignal): Promise<string> {
    const text = await engine.complete({
      instructions: SUMMARIZATION_SYSTEM_PROMPT,
      prompt,
      signal,
      maxOutputTokens,
    });

    assertSummary(text);
    return text.trim();
  }

  async function context(teraId: string, signal: AbortSignal): Promise<TeraContext> {
    await settle(teraId, signal);
    return readContext(store, teraId);
  }

  /** 走っている圧縮があれば、終わるまで待つ。ターンが止まったら待つのをやめる。 */
  async function settle(teraId: string, signal: AbortSignal): Promise<void> {
    const current = running.get(teraId);
    if (current === undefined || signal.aborted) return;

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        signal.removeEventListener("abort", finish);
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      void current.then(finish, finish);
    });
  }

  function close(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { context, check, update, close };
}

/**
 * いま保存されている要約と、まだ畳んでいない履歴を、モデルへ渡す形にまとめる。
 * 要約と履歴は、間に await を挟まずに続けて読む（必ず同じ時点の組になる）。
 */
export function readContext(store: Store, teraId: string): TeraContext {
  const state = store.readCompaction(teraId);
  return {
    summary: state.summary === "" ? null : state.summary,
    messages: store.listMessagesSince(teraId, state.throughSeq),
  };
}

/**
 * 文脈のトークンの目安。
 * 最後のモデル呼び出しの usage が最も正確なので、それを土台にし、それより後の分だけ足す。
 * usage が無い（usage を返さないプロバイダ、中断したターン）ときは、全文を文字数から見積もる。
 */
function contextTokens(state: CompactionState, messages: readonly ChatMessage[]): number {
  // 圧縮より前の usage は、畳む前の広い文脈を指す。畳んだ直後にまた畳まないよう、使わない。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) break;
    if (message.role !== "assistant" || message.usage === null) continue;
    if (message.createdAt <= state.createdAt) break;

    let trailing = 0;
    for (let after = index + 1; after < messages.length; after += 1) {
      const rest = messages[after];
      if (rest !== undefined) trailing += estimateMessageTokens(rest);
    }
    return message.usage.inputTokens + message.usage.outputTokens + trailing;
  }

  // 要約も文脈の一部なので、見積もりには含める。
  return (state.summary === "" ? 0 : estimateTokens(summaryText(state.summary))) + sumTokens(messages);
}

/** 直近を生のまま残す切れ目。 */
type CutPoint = {
  /** ここから先を生のまま残す。 */
  firstKept: number;
  /** ターンの途中で切るとき、そのターンの user 発言の位置。切らないときは -1。 */
  turnStart: number;
  isSplitTurn: boolean;
};

/**
 * 直近を生のまま残す切れ目を探す。
 * 新しい方からトークンを足していき、keepRecentTokens に届いた位置で切る。
 *
 * 切れ目がターンの途中（assistant）なら、そのターンの user 発言まで遡り、
 * ターンの前半を「ターン前半」として別に要約する（pi の split turn と同じ扱い）。
 */
function findCutPoint(messages: readonly ChatMessage[], keepRecentTokens: number): CutPoint {
  let accumulated = 0;
  let cut = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) break;

    accumulated += estimateMessageTokens(message);
    if (accumulated >= keepRecentTokens) {
      cut = index;
      break;
    }
  }

  // 直近だけで予算に届かない。畳むものが無い。
  if (cut === -1) return { firstKept: 0, turnStart: -1, isSplitTurn: false };

  const entry = messages[cut];
  if (entry === undefined) return { firstKept: 0, turnStart: -1, isSplitTurn: false };
  if (entry.role === "user") return { firstKept: cut, turnStart: -1, isSplitTurn: false };

  const turnStart = findTurnStart(messages, cut);
  return { firstKept: cut, turnStart, isSplitTurn: turnStart !== -1 };
}

/** その位置を含むターンの user 発言を、古い方へ探す。見つからなければ -1。 */
function findTurnStart(messages: readonly ChatMessage[], index: number): number {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.role === "user") return cursor;
  }
  return -1;
}

/** 古い方から、1 回に載せる量に収まる範囲を切り出す。1 件で超えるものは、その 1 件だけを返す。 */
function takeChunk(messages: readonly ChatMessage[], maxTokens: number): ChatMessage[] {
  const chunk: ChatMessage[] = [];
  let used = 0;

  for (const message of messages) {
    const size = estimateMessageTokens(message);
    if (chunk.length > 0 && used + size > maxTokens) break;
    chunk.push(message);
    used += size;
  }
  return chunk;
}

/**
 * 要約として使えるかを確かめる。
 * 中身が無いまま畳むと、畳んだはずのやり取りがどこにも残らなくなる。
 */
function assertSummary(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("要約の結果が空でした");
  if (!/^## /m.test(trimmed)) {
    throw new Error(`要約に決まった見出しがありません: ${trimmed.slice(0, 200)}`);
  }
}

/** 要約の呼び出しに渡す本文。変わる情報は末尾へ置く（プロンプトキャッシュの規則と同じ並べ方）。 */
function conversationPrompt(messages: readonly ChatMessage[], previousSummary: string): string {
  const parts = [`<conversation>\n${serializeConversation(messages)}\n</conversation>`];
  if (previousSummary !== "") parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
  parts.push(previousSummary === "" ? SUMMARY_PROMPT : UPDATE_SUMMARY_PROMPT);
  return parts.join("\n\n");
}

/**
 * 会話を、要約に見せる平文にする。
 * 会話として続きを書かせないよう、発言の頭に役割を付ける。
 * ツールの結果は長いので切り詰める（要約に全部は要らない）。
 */
function serializeConversation(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`[User]: ${message.content}`);
      continue;
    }

    if (message.parts === null) {
      lines.push(`[Assistant]: ${message.content}`);
      continue;
    }

    const text = message.parts
      .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.length > 0) lines.push(`[Assistant]: ${text}`);

    const calls = message.parts.filter(
      (part): part is Extract<MessagePart, { type: "tool-call" }> => part.type === "tool-call",
    );
    if (calls.length > 0) {
      lines.push(`[Assistant tool calls]: ${calls.map(formatCall).join("; ")}`);
    }

    for (const part of message.parts) {
      if (part.type !== "tool-result") continue;

      const label = part.failed ? "Tool result (failed)" : "Tool result";
      const images = (part.images ?? []).map((image) => ` [image ${image.width}x${image.height}]`).join("");
      lines.push(`[${label}]: ${truncate(part.output)}${images}`);
    }
  }

  return lines.join("\n\n");
}

/** ツールの呼び出しを、`名前(引数)` の形にする。 */
function formatCall(part: Extract<MessagePart, { type: "tool-call" }>): string {
  return `${toolNameFor(part.server, part.tool)}(${formatArgs(part.args)})`;
}

/** 引数を `key=値` の並びにする。オブジェクトでなければ、そのまま JSON にする。 */
function formatArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return jsonOf(args);

  return Object.entries(args as Record<string, unknown>)
    .map(([key, value]) => `${key}=${jsonOf(value)}`)
    .join(", ");
}

function jsonOf(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

/** 要約に見せる本文を、決めた長さに切る。切り詰めたことは本文に残す。 */
function truncate(text: string, limit: number = TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} more characters truncated]`;
}

/**
 * 要約への指示。
 * 出力は定型の見出しに揃える。会話を続けさせないため、応答ではなく要約だけを書かせる。
 */
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/**
 * 最初の要約の指示。
 * 後から続きを担う別のモデルが読む前提で、目的・制約・進み具合・決めたこと・次にやることを残す。
 */
const SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, command lines, URLs, and error messages.`;

/**
 * 更新の指示。前の要約の情報を落とさずに、新しいやり取りを足す。
 * 要約を書き直す唯一の場所なので、古くなった項目はここで落とす。
 */
const UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, command lines, URLs, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, command lines, URLs, and error messages.`;

/** ターンの途中で切ったときの、前半の要約の指示。 */
const TURN_PREFIX_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/** トークン数の目安。閾値の判定にだけ使う（トークナイザは持たない）。 */
export function estimateTokens(text: string): number {
  // 半角は 4 文字で 1 トークン、それ以外（日本語など）は 1 文字で 1 トークンとして数える。
  let wide = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= 0x80) wide += 1;
  }
  return Math.ceil((text.length - wide) / 4 + wide);
}

/** メッセージ 1 件のトークンの目安。parts があるときは部品ごとに数える（本文は parts の text の連結）。 */
export function estimateMessageTokens(message: ChatMessage): number {
  if (message.parts === null) return estimateTokens(message.content);

  let total = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        total += estimateTokens(part.text);
        break;
      case "tool-call":
        total += estimateTokens(JSON.stringify(part.args) ?? "");
        break;
      case "tool-result":
        total += estimateTokens(part.output) + (part.images?.length ?? 0) * IMAGE_TOKENS;
        break;
    }
  }
  return total;
}

function sumTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

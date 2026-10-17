import { describeError } from "../shared/errors";
import type { ChatMessage } from "../shared/types";
import type { AgentEngine } from "./engine";
import { toolNameFor, type TeraContext } from "./prompt";
import type { Store } from "./store";

/**
 * 観察の記録（Observational Memory）。
 *
 * 会話が長くなっても、モデルへ渡す文脈を有界に保つための仕組み。
 * 背景で走る 2 つの呼び出しが、古いやり取りを日付つきの短い記録に置き換えていく。
 *
 * - 観察（Observer）: まだ記録していないやり取りが閾値を超えたら、古い方から観察して記録に足す
 * - 反映（Reflector）: 記録そのものが閾値を超えたら、書式はそのままで書き直して縮める
 *
 * どちらも会話には割り込まない。ターンが終わってから背景で走り、次のターンの頭で待つ。
 * 記録は追記だけで育つので、前置き（system プロンプト + 観察の記録）は記録が増えない限り変わらない。
 * これがプロンプトキャッシュの当たり続ける条件になっている。
 */

/** 観察を始める閾値（未観察の履歴のトークンの目安）。既定値は Mastra の Observational Memory と同じ。 */
const OBSERVE_TOKENS = 30_000;

/**
 * 生のまま残す直近の量。閾値の 20%（Mastra の bufferActivation: 0.8 と同じ割合）。
 * いま話している内容の細かい言い回しは、畳まずにそのまま見せる。
 */
const RETAIN_TOKENS = OBSERVE_TOKENS / 5;

/** 反映を始める閾値（観察の記録のトークンの目安）。既定値は Mastra と同じ。 */
const REFLECT_TOKENS = 40_000;

/**
 * 1 回の更新で観察する回数。
 * これを超える長さは、次の更新で続きから進む（1 回の更新で際限なく呼ばないため）。
 */
const MAX_OBSERVE_ROUNDS = 3;

/** 1 回の更新の上限。過ぎたら打ち切る（止まった呼び出しで次のターンを待たせ続けないため）。 */
const UPDATE_TIMEOUT_MS = 120_000;

/** 観察に見せる 1 件の本文の上限。長いツールの出力で呼び出しが膨らむのを防ぐ。 */
const OBSERVER_MAX_CHARS = 2_000;

/** 画像 1 枚の目安。実際の消費は大きさとプロバイダで変わるが、数える対象があることは忘れない。 */
const IMAGE_TOKENS = 1_000;

export type Memory = {
  /** モデルへ渡す文脈（観察の記録と、まだ観察していない生の履歴）。 */
  context(teraId: string): TeraContext;
  /** 走っている更新があれば、終わるまで待つ。ターンを始める前に呼ぶ。 */
  settle(teraId: string): Promise<void>;
  /** 閾値を超えていれば観察し、そのあと反映する。同じ Tera で重ねて走らせない。 */
  update(teraId: string): Promise<void>;
};

export type CreateMemoryOptions = {
  store: Store;
  /** 観察と反映に使う呼び出し（ツールを使わない 1 回の生成）。 */
  engine: Pick<AgentEngine, "complete">;
  /** 失敗を端末へ出す口。会話は止めないが、黙らない。 */
  log: (message: string) => void;
};

export function createMemory(options: CreateMemoryOptions): Memory {
  const { store, engine, log } = options;
  /** 走っている更新。同じ Tera で 2 つ重ねないための 1 箇所。 */
  const running = new Map<string, Promise<void>>();

  function update(teraId: string): Promise<void> {
    const current = running.get(teraId);
    if (current !== undefined) return current;

    const job = run(teraId).finally(() => running.delete(teraId));
    running.set(teraId, job);
    return job;
  }

  function settle(teraId: string): Promise<void> {
    // 走っていなければ、待つものは無い。
    return running.get(teraId) ?? Promise.resolve();
  }

  async function run(teraId: string): Promise<void> {
    // 更新そのものに期限を置く（止まった呼び出しで、次のターンを待たせ続けない）。
    const signal = AbortSignal.timeout(UPDATE_TIMEOUT_MS);

    try {
      await observe(teraId, signal);
      await reflect(teraId, signal);
    } catch (error) {
      // 記憶を作れなくても、観察していない発言は生のままモデルへ渡る（内容は失われない）。
      // ただし黙って続けない。理由を端末へ出す。
      log(`  記憶: 更新できませんでした（${teraId}）— ${describeError(error)}`);
    }
  }

  /** 未観察の履歴が閾値を超えている間、古い方から観察して記録に足す。 */
  async function observe(teraId: string, signal: AbortSignal): Promise<void> {
    for (let round = 0; round < MAX_OBSERVE_ROUNDS; round += 1) {
      const memory = store.readObservations(teraId);
      const pending = store.listMessagesSince(teraId, memory.throughSeq);
      if (sumTokens(pending) <= OBSERVE_TOKENS) return;

      const chunk = takeChunk(pending);
      const added = await engine.complete({
        instructions: OBSERVER_INSTRUCTIONS,
        prompt: observerPrompt(memory.text, chunk.messages),
        signal,
      });
      assertObservations(added, "観察");

      store.writeObservations(teraId, {
        text: appendObservations(memory.text, added.trim()),
        throughSeq: chunk.throughSeq,
      });
    }
  }

  /** 記録が閾値を超えていれば、書き直して縮める。 */
  async function reflect(teraId: string, signal: AbortSignal): Promise<void> {
    const memory = store.readObservations(teraId);
    if (estimateTokens(memory.text) <= REFLECT_TOKENS) return;

    const rewritten = await engine.complete({
      instructions: REFLECTOR_INSTRUCTIONS,
      prompt: memory.text,
      signal,
    });
    assertObservations(rewritten, "反映");

    store.writeObservations(teraId, { text: rewritten.trim(), throughSeq: memory.throughSeq });
  }

  function context(teraId: string): TeraContext {
    // 記録と未観察の履歴は、間に await を挟まずに続けて読む（必ず同じ時点の組になる）。
    const memory = store.readObservations(teraId);
    const messages = store.listMessagesSince(teraId, memory.throughSeq);
    return { observations: memory.text === "" ? null : memory.text, messages };
  }

  return { context, settle, update };
}

/** 観察する範囲。切り出したメッセージと、そこまでの seq。 */
type Chunk = {
  messages: ChatMessage[];
  throughSeq: number;
};

/**
 * 観察する範囲を古い方から切り出す。
 * 一度に観察するのは OBSERVE_TOKENS まで（1 回の呼び出しを膨らませすぎない）。
 * 直近 RETAIN_TOKENS は生のまま残す。
 * 1 件で上限を超えるメッセージは、その 1 件だけを観察する（そうしないと先へ進めない）。
 */
function takeChunk(pending: readonly ChatMessage[]): Chunk {
  const sizes = pending.map(estimateMessageTokens);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const limit = Math.min(OBSERVE_TOKENS, total - RETAIN_TOKENS);

  const messages: ChatMessage[] = [];
  let used = 0;
  for (const [index, message] of pending.entries()) {
    const size = sizes[index] ?? 0;
    if (messages.length > 0 && used + size > limit) break;
    messages.push(message);
    used += size;
  }

  const last = messages.at(-1);
  if (last === undefined) throw new Error("観察する範囲を切り出せませんでした");
  return { messages, throughSeq: last.seq };
}

/**
 * 観察の記録に、新しい観察を足す。
 * 同じ日付が続くときは見出しを繰り返さない（日付ごとに 1 つの並びにする）。
 */
function appendObservations(log: string, added: string): string {
  if (log.length === 0) return added;

  const [first, ...rest] = added.split("\n");
  const header = first?.trim() ?? "";
  if (header.startsWith("Date: ") && header === lastDateHeader(log)) {
    return `${log}\n${rest.join("\n").trim()}`;
  }
  return `${log}\n\n${added}`;
}

/** 記録の最後の日付の見出し。無ければ null。 */
function lastDateHeader(log: string): string | null {
  for (const line of log.split("\n").reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Date: ")) return trimmed;
  }
  return null;
}

/**
 * 観察として使えるかを確かめる。
 * 中身が無いまま記録を進めると、観察したはずのやり取りがどこにも残らなくなる。
 */
function assertObservations(text: string, what: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error(`${what}の結果が空でした`);

  const hasBullet = trimmed.split("\n").some((line) => /^\s*[*-] /.test(line));
  if (!hasBullet) throw new Error(`${what}の結果に観察の行がありません: ${clipped(trimmed, 200)}`);
}

/**
 * 観察へ見せる会話。1 行 1 件にして、頭に時刻を付ける。
 * 長い出力は切り詰める（ツールの出力が大きいと、1 回の呼び出しが膨らみすぎる）。
 */
function toTranscript(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    const at = formatDateTime(message.createdAt);
    if (message.parts === null) {
      lines.push(`[${at}] ${message.role}: ${clipped(message.content)}`);
      continue;
    }

    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          lines.push(`[${at}] ${message.role}: ${clipped(part.text)}`);
          break;
        case "tool-call":
          lines.push(
            `[${at}] ${message.role}: (called ${toolNameFor(part.server, part.tool)} with ${clipped(JSON.stringify(part.args) ?? "")})`,
          );
          break;
        case "tool-result":
          lines.push(
            `[${at}] tool ${toolNameFor(part.server, part.tool)}${part.failed ? " (failed)" : ""}: ` +
              `${clipped(part.output)}${part.image === undefined ? "" : ` (image ${part.image.width}x${part.image.height})`}`,
          );
          break;
      }
    }
  }

  return lines.join("\n");
}

/** 1 件の本文を、観察に見せる長さに切る。切り詰めたことは本文に残す。 */
function clipped(text: string, limit: number = OBSERVER_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…[truncated ${flat.length - limit} chars]`;
}

/** 観察の呼び出しに渡す本文。変わる情報は末尾へ置く（プロンプトキャッシュの規則と同じ並べ方）。 */
function observerPrompt(log: string, messages: readonly ChatMessage[]): string {
  return [
    `<memory>\n${log.length === 0 ? "(no memory yet)" : log}\n</memory>`,
    `<transcript>\n${toTranscript(messages)}\n</transcript>`,
    `Today is ${localDate()}.`,
    "Write the observations to append for the transcript above.",
  ].join("\n\n");
}

/**
 * 観察（Observer）への指示。
 * 出力は「足す分の観察だけ」にする。記録全体を書き直させないのは、
 * 記録が追記だけで育つ（= 前のターンと頭から一致する）状態を保つため。
 */
const OBSERVER_INSTRUCTIONS = `You hold the long-term memory of an assistant that talks with one user.
You are given the memory so far, and the part of the conversation that has not been written down yet.
Turn that part into observations: short, dense, dated notes about what happened.

Output ONLY the observations to append. Never repeat or rewrite what the memory already says.
Start with a "Date:" line for the oldest date in the transcript.

FORMAT
Write in the language the user writes in. Group observations by date, oldest first:

Date: 2026-10-17
* 🔴 (14:30) The user said they work in Kyoto and commute by bicycle.
* 🟡 (14:31) The assistant checked the container and found Chromium installed.
  * -> ran "which chromium", then opened the browser

PRIORITY
* 🔴 high: what the user stated about themselves, their preferences, decisions, and open requests
* 🟡 medium: what the assistant did and learned — tool calls, results, choices it made
* 🟢 low: small details that may or may not matter later
* ✅ done: something that was finished or resolved

RULES
* Begin every observation with a priority emoji and the local time taken from the transcript.
* Keep the user's own words close when they state something. Never invent facts.
* One observation per event. Group a sequence of tool calls under one bullet with sub-bullets.
* If a statement points at a relative time ("next week"), add the date it means at the end: (meaning 2026-10-24).
* When something replaces an earlier state, say so: (replacing ...).
* Be terse. No preamble, no summary of the whole conversation, no headings other than "Date:".
* At most 5 observations per exchange. Small talk is not worth remembering.

Transcript lines look like "[2026-10-17 14:30] user: ...". Times are the user's local time.`;

/**
 * 反映（Reflector）への指示。
 * 記録を書き直させる唯一の場所。縮めつつ、後から効く具体（名前・数・好み・決めたこと）は残す。
 */
const REFLECTOR_INSTRUCTIONS = `You condense the long-term memory of an assistant that talks with one user.
Rewrite the memory below into a shorter one, in exactly the same format.

* Merge observations about the same thing into one.
* Drop what has been replaced or no longer matters. Keep the state that is current.
* Keep concrete facts: names, dates, numbers, preferences, decisions, and what is still open.
* Keep each observation's date and time. Keep the recent part more detailed than the old part.
* Never add anything that is not in the memory below.

Output only the rewritten memory, starting with its first "Date:" line. No preamble, no notes about what you changed.`;

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
        total += estimateTokens(part.output) + (part.image === undefined ? 0 : IMAGE_TOKENS);
        break;
    }
  }
  return total;
}

function sumTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** 端末の時間帯で「YYYY-MM-DD」。 */
function localDate(at: number = Date.now()): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 観察に書く時刻。端末の時間帯で「YYYY-MM-DD HH:MM」。 */
function formatDateTime(at: number): string {
  const date = new Date(at);
  return `${localDate(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

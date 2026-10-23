import { describeError } from "../../shared/errors";
import type { ChatMessage } from "../../shared/api/message";
import type { CompactionState, Store } from "../data/store";
import {
  assertSummary,
  conversationPrompt,
  serializeConversation,
  SUMMARIZATION_SYSTEM_PROMPT,
  TURN_PREFIX_PROMPT,
} from "./compaction-text";
import type { AgentEngine } from "./engine";
import type { TeraContext } from "./prompt";
import { contextTokens, estimateMessageTokens, estimateTokens } from "./tokens";

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
 *
 * 要約を書き換えたときは、Tera が書いた identity も system プロンプト用の版へ切り替える。
 * 畳むものが無いときや失敗したときは切り替えない。書き換えた直後には反映されないので、
 * 次の圧縮まではプロンプト（とキャッシュ）がそのまま保たれる。
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
  /**
   * その Tera の畳みをやめる。予約を外し、走っている分は打ち切って終わるまで待つ。
   * Tera を消す前に呼ぶ（同じ id を作り直した先へ、古い会話の要約が書かれるのを防ぐ）。
   */
  cancel(teraId: string): Promise<void>;
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
  /** 走っている更新。同じ Tera で 2 つ重ねないための 1 箇所。消すときに打ち切れるよう、口も持つ。 */
  const running = new Map<string, { job: Promise<void>; controller: AbortController }>();
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
    clearTimer(teraId);

    const state = store.readCompaction(teraId);
    // 件数・最終時刻・文字数だけを SQL で見る（全履歴の JSON を開かない）。
    const stats = store.readPendingStats(teraId, state.throughSeq);
    if (stats.count === 0 || stats.lastCreatedAt === null) return;

    // トークンの目安は文字数から。閾値に近いときだけ、正確に数えるために全履歴を読む。
    const rough = estimateTokens(state.summary) + Math.ceil(stats.chars / 2) + stats.count * 16;
    if (rough > threshold() * 0.7) {
      const pending = store.listMessagesSince(teraId, state.throughSeq);
      if (contextTokens(state, pending) > threshold()) {
        void update(teraId);
        return;
      }
    }

    // それ以外は、最後のやり取りから 3 時間たつまで待つ。
    const at = stats.lastCreatedAt + IDLE_MS;
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

  function clearTimer(teraId: string): void {
    const timer = timers.get(teraId);
    if (timer === undefined) return;

    clearTimeout(timer);
    timers.delete(teraId);
  }

  function update(teraId: string, options: { force?: boolean } = {}): Promise<void> {
    const current = running.get(teraId);
    if (current !== undefined) return current.job;

    const controller = new AbortController();
    const job = run(teraId, options.force === true, controller.signal).finally(() => running.delete(teraId));
    running.set(teraId, { job, controller });
    return job;
  }

  /** 走っている畳みを打ち切り、終わるまで待つ（Tera を消すときに呼ぶ）。 */
  async function cancel(teraId: string): Promise<void> {
    clearTimer(teraId);

    const current = running.get(teraId);
    if (current === undefined) return;

    current.controller.abort();
    await current.job;
  }

  async function run(teraId: string, force: boolean, cancelSignal: AbortSignal): Promise<void> {
    // 更新そのものに期限を置く（長い履歴でも、1 回で際限なく呼び続けない）。
    // Tera を消すときは cancelSignal で、待たずに打ち切る。
    const signal = AbortSignal.any([AbortSignal.timeout(UPDATE_TIMEOUT_MS), cancelSignal]);

    try {
      await compact(teraId, force, signal);
    } catch (error) {
      // 畳めなくても、畳んでいないやり取りは生のままモデルへ渡る（内容は失われない）。
      // ただし黙って続けない。理由を端末へ出す。
      log(
        cancelSignal.aborted
          ? `  圧縮: 削除されたため打ち切りました（${teraId}）`
          : `  圧縮: 畳めませんでした（${teraId}） ${describeError(error)}`,
      );
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

    // 要約を書き換えたので、書かれている identity も system プロンプト用の版へ切り替える。
    // 畳むものが無いとき（下の early return）は、ここへ来ない。
    if (store.applyIdentity(teraId)) {
      log(`  圧縮: identity を新しい版に切り替えました（${teraId}）`);
    }

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
      void current.job.then(finish, finish);
    });
  }

  function close(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { context, check, update, cancel, close };
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

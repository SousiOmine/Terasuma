import type { ReplyLanguage } from "../../shared/language";
import { describeError } from "../../shared/errors";
import type {
  AttachmentPart,
  ChatAttachment,
  ChatEvent,
  ChatMessage,
  NoticePart,
  SentAttachment,
  TextPart,
  TokenUsage,
} from "../../shared/api/message";
import type { Compaction } from "./compaction";
import type { AgentEngine } from "./engine";
import { toMessageView } from "./message-view";
import type { TeraContext } from "./prompt";
import { createStepMessages } from "./step-messages";
import type { Store } from "../data/store";

/**
 * 1 ターン分の流れと、同じ Tera でターンが重ならないための門。
 *
 * ルーチンのターンも同じ 1 本の枠を使う（重ねない）。
 *
 * 保存 → モデル呼び出し → 保存、の順で進み、履歴は常に追記だけになる。
 * 「実行中かどうか」はこのモジュールの中だけで持ち、HTTP 層へ Set を渡さない。
 *
 * ターンは 1 つ以上の区切りからなる。応答の途中で利用者が発言を足したら、
 * その区切りの中では次のモデル呼び出しの直前（prepareStep）に文脈へ足す。
 * 最後の呼び出しに間に合わなかった発言は、ターンを終える前に続きの区切りで応答する。
 *
 * モデルの本文は text パートとして画面へ流す。画像やファイルはエージェントが
 * chat_attach で添付し（parts の attachment）、システムの注記は notice に残る。
 */

/** ターンを流すのに必要なもの。 */
export type TurnDeps = {
  store: Store;
  engine: AgentEngine;
  /** 過去の対話の圧縮。ターンの前に走っている分を待ち、ターンの後に次を決める。 */
  compaction: Compaction;
};

/** ターンを始めたきっかけ。 */
export type TurnOrigin =
  /** 利用者が送った。 */
  | { kind: "user" }
  /** ルーチンの実行。 */
  | { kind: "routine"; routineId: string; routineName: string };

/** 1 ターンの入力。 */
export type TurnInput = {
  /** ユーザーが書いた本文。 */
  content: string;
  /** ユーザーが添付したファイル。無ければ null。 */
  attachments: ChatAttachment[] | null;
  language: ReplyLanguage;
};

/** 応答の途中で足す、利用者の発言。 */
export type SteerInput = {
  /** ユーザーが書いた本文。 */
  content: string;
  /** ユーザーが添付したファイル。無ければ null。 */
  attachments: ChatAttachment[] | null;
};

export type Turns = {
  /**
   * ターンを始める。同じ Tera で実行中なら null（重ねて流さない）。
   * 終わったら（止められた場合も）実行中の印は必ず外れる。
   * startUserMessage が false なら、最初の区切りでユーザー発言を保存しない（再試行用）。
   */
  begin(
    teraId: string,
    input: TurnInput,
    options?: { startUserMessage?: boolean; origin?: TurnOrigin },
  ): AsyncIterable<ChatEvent> | null;
  /** 応答を生成しているターンがあるかどうか。 */
  isRunning(teraId: string): boolean;
  /** いま走っているターンを始めたきっかけ。走っていなければ null。 */
  runningOrigin(teraId: string): TurnOrigin | null;
  /**
   * この Tera のターンが登録されているかどうか（停止を押して、片付けている途中も含む）。
   * Tera を消す前に確かめる。止めたターンは、終わるまで履歴を書き足すため。
   */
  hasTurn(teraId: string): boolean;
  /**
   * 走っているターンの途中へ、利用者の発言を足す。
   * 発言は保存され、次のモデル呼び出しの直前に文脈の末尾へ入る。
   * ターンが動いていない（止めている途中を含む）なら null。何も保存しない。
   */
  steer(teraId: string, input: SteerInput): ChatMessage | null;
  /**
   * 走っているターンを止める。エージェントはそこで打ち切り、それまでに書いた
   * 本文や添付は保存して assistant-done で返す。
   * 止めるターンが無ければ false（すでに終わっている。呼び直しても害はない）。
   */
  stop(teraId: string): boolean;
};

/** 一時的な失敗のときに、やり直すまでの待ち（ミリ秒）。回数はこの配列の長さ。 */
const RETRY_DELAYS_MS = [1_000, 3_000];

/** signal が立つか、待ち時間が過ぎるまで待つ。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 1 つのターンの実行状態。 */
type RunningTurn = {
  controller: AbortController;
  /** 利用者の「停止」で止めたかどうか。止められたことを失敗として扱わない。 */
  stopped: boolean;
  /** 保存したが、まだモデルへ渡していない発言（届いた順）。 */
  pending: ChatMessage[];
  /** このターンを始めたきっかけ。保存する発言の origin を決める。 */
  origin: TurnOrigin;
};

export function createTurns(deps: TurnDeps): Turns {
  const { store } = deps;

  /** いま応答を生成している Tera と、その中止の口。 */
  const running = new Map<string, RunningTurn>();

  return {
    begin(teraId, input, options) {
      const origin: TurnOrigin = options?.origin ?? { kind: "user" };

      // 画面は 1 つのターンしか始めないが、別のタブから同じ Tera を開けるため、ここでも断る。
      if (running.has(teraId)) return null;

      const turn: RunningTurn = { controller: new AbortController(), stopped: false, pending: [], origin };
      running.set(teraId, turn);
      return runTurn(deps, teraId, input, turn, running, options?.startUserMessage ?? true);
    },

    isRunning(teraId) {
      const turn = running.get(teraId);
      return turn !== undefined && !turn.stopped;
    },

    runningOrigin(teraId) {
      return running.get(teraId)?.origin ?? null;
    },

    hasTurn(teraId) {
      return running.has(teraId);
    },

    steer(teraId, input) {
      const turn = running.get(teraId);
      // 止めている途中のターンには足さない。足しても応答しないまま履歴に残る。
      if (turn === undefined || turn.stopped) return null;

      const message = store.appendMessage({
        id: crypto.randomUUID(),
        teraId,
        role: "user",
        content: input.content,
        attachments: input.attachments,
        origin: null,
      });
      turn.pending.push(message);
      return message;
    },

    stop(teraId) {
      const turn = running.get(teraId);
      if (turn === undefined) return false;

      turn.stopped = true;
      turn.controller.abort();
      return true;
    },
  };
}

/**
 * ターン分のイベント列。終わったら、実行中の印を必ず外す。
 * 停止 API で打ち切った場合も、finally は通る。
 */
async function* runTurn(
  deps: TurnDeps,
  teraId: string,
  input: TurnInput,
  turn: RunningTurn,
  running: Map<string, RunningTurn>,
  startUserMessage: boolean,
): AsyncGenerator<ChatEvent> {
  try {
    // 最初の区切りは、送られた発言から始まる。
    // 途中で届いた発言が残っていたら（最後のモデル呼び出しに間に合わなかった）、
    // 続けてその発言に応答する。届いたのに返事が無いままにしない。
    let startsTurn = startUserMessage;
    for (;;) {
      const completed = yield* turnEvents(deps, teraId, input, turn, startsTurn);
      startsTurn = false;
      if (!completed || turn.stopped || turn.controller.signal.aborted) break;
      if (turn.pending.length === 0) break;
    }
  } finally {
    running.delete(teraId);

    // ターンが終わってから、次に畳む時を決める（要れば今すぐ、要らなければ 3 時間後に予約）。
    deps.compaction.check(teraId);
  }
}

/**
 * 1 区切り分のイベント列。
 *
 * 保存 → モデル呼び出し → 保存、の順で進み、履歴は常に追記だけになる。
 * startsTurn が true のときだけ、このターンの発言を保存して画面へ流す
 * （途中で届いた発言は steer が保存済みなので、続きの区切りでは流さない）。
 *
 * 戻り値は、この区切りを最後まで流せたかどうか（失敗したら false）。
 */
async function* turnEvents(
  deps: TurnDeps,
  teraId: string,
  { content, attachments, language }: TurnInput,
  turn: RunningTurn,
  startsTurn: boolean,
): AsyncGenerator<ChatEvent, boolean> {
  const { store, engine, compaction } = deps;

  // Tera は起動時に用意されている（無い id は、ここへ来る前に断っている）。
  if (startsTurn) {
    const userMessage = store.appendMessage({
      id: crypto.randomUUID(),
      teraId,
      role: "user",
      content,
      attachments,
      // ルーチンが始めたターンは、画面で自分の発言と区別できるように名前を残す。
      origin: turn.origin.kind === "routine" ? turn.origin.routineName : null,
    });
    yield { type: "user-message", message: toMessageView(userMessage) };
  }

  const steps = createStepMessages(store, teraId);
  let draft = steps.current();
  yield { type: "assistant-start", id: draft.id, createdAt: draft.createdAt, seq: draft.seq };

  /** まだ画面へ流していない、本文と添付。 */
  const outgoing: (TextPart | AttachmentPart)[] = [];
  /** いま伸びている本文。区切りが付くまで、画面へは流さない。 */
  let pendingText: TextPart | null = null;

  /**
   * 添付の口。いまのステップの記録へはその場で足す（止められても、添付は保存に残す）。
   * 画面へは、次のモデルの出来事を待つ間に流す。
   */
  const attach = (attachments: SentAttachment[]): void => {
    if (attachments.length === 0) throw new Error("添付なしで attach が呼ばれました");

    const part: AttachmentPart = { type: "attachment", attachments, at: Date.now() };
    draft.parts.push(part);
    outgoing.push(part);
  };

  const appendText = (delta: string): void => {
    if (delta.length === 0) return;

    const last = draft.parts.at(-1);
    if (last?.type === "text") {
      last.text += delta;
      pendingText = last;
      return;
    }

    const part: TextPart = { type: "text", text: delta, at: Date.now() };
    draft.parts.push(part);
    pendingText = part;
  };

  /** いま伸びている本文を、区切りとして画面へ流せるようにする。 */
  const flushText = (): void => {
    if (pendingText === null) return;
    outgoing.push(pendingText);
    pendingText = null;
  };

  let usage: TokenUsage | null = null;
  let failure: string | null = null;
  let finalMessage: ChatMessage | null = null;

  /**
   * 生成済みの内容は、正常終了でも「停止」でも必ず保存する。
   * 停止時は呼び出し元がジェネレータを return するため、yield を含む後続のコードは実行されない。
   * だから保存だけは finally から呼べる形に切り出してある。
   * 何も出なかったステップの行は残さない。
   */
  const persist = (): void => {
    if (finalMessage !== null) return;
    finalMessage = steps.finish(usage);
  };

  // まだモデルへ渡していない発言は、この区切りの最初のモデル呼び出しから見えるよう、
  // 文脈の末尾へ移す。保存された位置からは外す（同じ発言を二重に渡さない）。
  // 続きの区切りでは、前の区切りに間に合わなかった発言がここで末尾に来て、最新の指示として読まれる。
  // やり直しても失わないよう、取り出しは試行のループの外で 1 回だけ行う。
  const steering = turn.pending;
  turn.pending = [];

  try {
    // 畳んだ要約と、まだ畳んでいない生の履歴。生の履歴には要約も並べ替えもしない
    // （プロンプトキャッシュが当たり続けるようにするため）。
    const context = await compaction.context(teraId, turn.controller.signal);

    let attempts = 0;
    for (;;) {
      try {
        const stream = await engine.stream({
          context: withSteering(context, steering),
          signal: turn.controller.signal,
          teraId,
          replyLanguage: language,
          attach,
          // 区切りの途中で届いた発言は、次のモデル呼び出しの直前に足す。
          takeSteering: () => {
            const arrived = turn.pending;
            turn.pending = [];
            return arrived;
          },
        });

        /** 最初の step-start は、ターンの冒頭で開いた行がそのまま受け持つ。 */
        let seenFirstStep = false;

        for await (const event of stream.events) {
          // 本文は、次の区切り（ツール呼び出し・結果・注記・終了）で確定する。
          if (event.type !== "text-delta") flushText();

          // 確定した本文と添付を、次のモデルの出来事より先に流す。
          while (outgoing.length > 0) {
            const part = outgoing.shift();
            if (part !== undefined) yield { type: "assistant-message", id: draft.id, part };
          }

          switch (event.type) {
            case "step-start":
              // AI SDK は最初のステップでも start-step を流す。冒頭で開いた行を使い続ける。
              if (!seenFirstStep) {
                seenFirstStep = true;
                break;
              }
              // ステップの境目。ここで行を分けるので、この直後に届く追加の発言（steering）は
              // 必ず前の行より後ろの連番になり、次の行はその下に描かれる。
              draft = steps.nextStep(null);
              yield { type: "assistant-start", id: draft.id, createdAt: draft.createdAt, seq: draft.seq };
              break;
            case "text-delta":
              // 本文は画面に出す。区切りが付くまで溜め、まとめて 1 つの吹き出しにする。
              appendText(event.delta);
              break;
            case "tool-call":
              draft.parts.push(event.part);
              yield { type: "tool-call", id: draft.id, part: event.part };
              break;
            case "tool-result":
              draft.parts.push(event.part);
              yield { type: "tool-result", id: draft.id, part: event.part };
              break;
            case "step-limit": {
              // 上限で打ち切られたことを、画面に残す。
              const part: NoticePart = { type: "notice", text: stepLimitNote(language), at: Date.now() };
              draft.parts.push(part);
              yield { type: "notice", id: draft.id, part };
              break;
            }
          }
        }

        usage = await stream.usage;
        break;
      } catch (error) {
        // 利用者の「停止」は失敗ではない。それ以外の失敗だけを画面へ返す。
        if (turn.stopped || turn.controller.signal.aborted) break;

        // まだ何も記録していないときだけやり直す。ツールを呼んだ後は、副作用を重ねない。
        const canRetry = !steps.sawContent() && draft.parts.length === 0 && attempts < RETRY_DELAYS_MS.length;
        if (!canRetry) {
          failure = describeError(error);
          break;
        }

        // 画面へ流していない本文を捨てる。残すと、やり直した分と二重に流れる。
        pendingText = null;
        outgoing.length = 0;

        await delay(RETRY_DELAYS_MS[attempts] ?? 0, turn.controller.signal);
        attempts += 1;
        if (turn.stopped || turn.controller.signal.aborted) break;
      }
    }
  } catch (error) {
    // 文脈の読み込みなど、モデル呼び出しの外で起きた失敗はやり直さない。
    if (!turn.stopped && !turn.controller.signal.aborted) failure = describeError(error);
  } finally {
    persist();
  }

  // 最後の本文と、まだ流していない添付を流し切る。
  flushText();
  while (outgoing.length > 0) {
    const part = outgoing.shift();
    if (part !== undefined) yield { type: "assistant-message", id: draft.id, part };
  }

  // 何も書かずに終わったターンは、黙って終わらせない。
  // 本文も添付も注記も無ければ、ユーザーには何も届いていない。
  if (failure === null && !turn.stopped && !turn.controller.signal.aborted && !steps.sawContent()) {
    failure = "The model finished without writing a reply.";
  }

  if (failure === null) {
    if (finalMessage !== null) yield { type: "assistant-done", message: toMessageView(finalMessage) };
    return true;
  }

  // クライアントが離脱済みなら届け先が無いのでイベントにしない。
  if (!turn.controller.signal.aborted) {
    yield { type: "error", code: "model_error", detail: failure };
  }
  return false;
}

/**
 * まだモデルへ渡していない発言を、文脈の末尾へ移す。
 * 保存された位置からは外すので、同じ発言が二重に渡ることはない。
 * 末尾に来るので、モデルは最新の指示として読める。
 */
function withSteering(context: TeraContext, steering: readonly ChatMessage[]): TeraContext {
  if (steering.length === 0) return context;

  const ids = new Set(steering.map((message) => message.id));
  return {
    ...context,
    messages: [...context.messages.filter((message) => !ids.has(message.id)), ...steering],
  };
}

/**
 * 1 ターンのステップの上限で打ち切られたときに、ユーザーへ出す注記。
 * 黙って切れると、応答が途中で終わった理由が画面から分からない。
 * 設定した返事の言語に合わせる。
 */
function stepLimitNote(language: ReplyLanguage): string {
  return language === "ja"
    ? "1 回の応答で扱える操作の上限に達したため、ここで止まりました。続きは、もう一度送ってください。"
    : "Stopped here because this turn reached the tool-call limit. Send another message to continue.";
}

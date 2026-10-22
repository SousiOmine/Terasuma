import type { ReplyLanguage } from "../../shared/language";
import { describeError } from "../../shared/errors";
import { toolNameFor, UI_TOOL_NAME } from "../../shared/tools";
import type {
  AttachmentPart,
  ChatAttachment,
  ChatEvent,
  ChatMessage,
  MessagePart,
  NoticePart,
  SentAttachment,
  TextPart,
  TokenUsage,
} from "../../shared/types";
import type { Compaction } from "./compaction";
import type { AgentEngine } from "./engine";
import type { Store } from "../data/store";

/**
 * 1 ターン分の流れと、同じ Tera でターンが重ならないための門。
 *
 * 保存 → モデル呼び出し → 保存、の順で進み、履歴は常に追記だけになる。
 * 「実行中かどうか」はこのモジュールの中だけで持ち、HTTP 層へ Set を渡さない。
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

/** 1 ターンの入力。 */
export type TurnInput = {
  /** ユーザーが書いた本文。 */
  content: string;
  /** ユーザーが添付したファイル。無ければ null。 */
  attachments: ChatAttachment[] | null;
  language: ReplyLanguage;
  signal: AbortSignal;
};

export type Turns = {
  /**
   * ターンを始める。同じ Tera で実行中なら null（重ねて流さない）。
   * 終わったら（止められた場合も）実行中の印は必ず外れる。
   */
  begin(teraId: string, input: TurnInput): AsyncIterable<ChatEvent> | null;
  /**
   * 走っているターンを止める。エージェントはそこで打ち切り、それまでに書いた
   * 本文や添付は保存して assistant-done で返す。
   * 止めるターンが無ければ false（すでに終わっている。呼び直しても害はない）。
   */
  stop(teraId: string): boolean;
};

/** 1 つのターンの実行状態。 */
type RunningTurn = {
  controller: AbortController;
  /** 利用者の「停止」で止めたかどうか。止められたことを失敗として扱わない。 */
  stopped: boolean;
};

export function createTurns(deps: TurnDeps): Turns {
  /** いま応答を生成している Tera と、その中止の口。 */
  const running = new Map<string, RunningTurn>();

  return {
    begin(teraId, input) {
      // 画面は 1 つのターンしか始めないが、別のタブから同じ Tera を開けるため、ここでも断る。
      if (running.has(teraId)) return null;

      const turn: RunningTurn = { controller: new AbortController(), stopped: false };
      running.set(teraId, turn);
      return runTurn(deps, teraId, input, turn, running);
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
 * 1 ターン分のイベント列。終わったら、実行中の印を必ず外す。
 * 「停止」やタブの切断でジェネレータが閉じられた場合も、finally は通る。
 */
async function* runTurn(
  deps: TurnDeps,
  teraId: string,
  input: TurnInput,
  turn: RunningTurn,
  running: Map<string, RunningTurn>,
): AsyncGenerator<ChatEvent> {
  // タブが閉じられたときも、ターンを止めて片付ける。
  const onRequestAbort = (): void => turn.controller.abort();
  if (input.signal.aborted) turn.controller.abort();
  else input.signal.addEventListener("abort", onRequestAbort, { once: true });

  try {
    yield* turnEvents(deps, teraId, input, turn);
  } finally {
    input.signal.removeEventListener("abort", onRequestAbort);
    running.delete(teraId);

    // ターンが終わってから、次に畳む時を決める（要れば今すぐ、要らなければ 3 時間後に予約）。
    deps.compaction.check(teraId);
  }
}

/**
 * 1 ターン分のイベント列。
 * 保存 → モデル呼び出し → 保存、の順で進み、履歴は常に追記だけになる。
 */
async function* turnEvents(
  deps: TurnDeps,
  teraId: string,
  { content, attachments, language }: TurnInput,
  turn: RunningTurn,
): AsyncGenerator<ChatEvent> {
  const { store, engine, compaction } = deps;

  // Tera は起動時に用意されている（無い id は、ここへ来る前に断っている）。
  const userMessage = store.appendMessage({
    id: crypto.randomUUID(),
    teraId,
    role: "user",
    content,
    attachments,
  });
  yield { type: "user-message", message: userMessage };

  const assistantId = crypto.randomUUID();
  const createdAt = Date.now();
  yield { type: "assistant-start", id: assistantId, createdAt };

  /** このターンの記録（本文・ツール・添付・注記）。保存される並びそのもの。 */
  const parts: MessagePart[] = [];
  /** まだ画面へ流していない、本文と添付。 */
  const outgoing: (TextPart | AttachmentPart)[] = [];
  /** いま伸びている本文。区切りが付くまで、画面へは流さない。 */
  let pendingText: TextPart | null = null;

  /**
   * 添付の口。parts へはその場で足す（止められても、添付は保存に残す）。
   * 画面へは、次のモデルの出来事を待つ間に流す。
   */
  const attach = (attachments: SentAttachment[]): void => {
    if (attachments.length === 0) throw new Error("添付なしで attach が呼ばれました");

    const part: AttachmentPart = { type: "attachment", attachments, at: Date.now() };
    parts.push(part);
    outgoing.push(part);
  };

  const appendText = (delta: string): void => {
    if (delta.length === 0) return;

    const last = parts.at(-1);
    if (last?.type === "text") {
      last.text += delta;
      pendingText = last;
      return;
    }

    const part: TextPart = { type: "text", text: delta, at: Date.now() };
    parts.push(part);
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
   * 何も起きなかったターン（部分が 1 つも無い）は、空のメッセージを作らない。
   */
  const persist = (): void => {
    if (finalMessage !== null || parts.length === 0) return;

    finalMessage = store.appendMessage({
      id: assistantId,
      teraId,
      role: "assistant",
      content: "",
      attachments: null,
      parts,
      usage,
    });
  };

  try {
    // 畳んだ要約と、まだ畳んでいない生の履歴。生の履歴には要約も並べ替えもしない
    // （プロンプトキャッシュが当たり続けるようにするため）。
    const context = await compaction.context(teraId, turn.controller.signal);

    const stream = await engine.stream({
      context,
      signal: turn.controller.signal,
      teraId,
      replyLanguage: language,
      attach,
    });

    for await (const event of stream.events) {
      // 本文は、次の区切り（ツール呼び出し・結果・注記・終了）で確定する。
      if (event.type !== "text-delta") flushText();

      // 確定した本文と添付を、次のモデルの出来事より先に流す。
      while (outgoing.length > 0) {
        const part = outgoing.shift();
        if (part !== undefined) yield { type: "assistant-message", id: assistantId, part };
      }

      switch (event.type) {
        case "text-delta":
          // 本文は画面に出す。区切りが付くまで溜め、まとめて 1 つの吹き出しにする。
          appendText(event.delta);
          break;
        case "tool-call":
          parts.push(event.part);
          yield { type: "tool-call", id: assistantId, part: event.part };
          break;
        case "tool-result":
          parts.push(event.part);
          yield { type: "tool-result", id: assistantId, part: event.part };
          break;
        case "step-limit": {
          // 上限で打ち切られたことを、画面に残す。
          const part: NoticePart = { type: "notice", text: stepLimitNote(language), at: Date.now() };
          parts.push(part);
          yield { type: "notice", id: assistantId, part };
          break;
        }
      }
    }

    usage = await stream.usage;
  } catch (error) {
    // 利用者の「停止」やタブの切断は失敗ではない。それ以外の失敗だけを画面へ返す。
    if (!turn.stopped && !turn.controller.signal.aborted) failure = describeError(error);
  } finally {
    persist();
  }

  // 最後の本文と、まだ流していない添付を流し切る。
  flushText();
  while (outgoing.length > 0) {
    const part = outgoing.shift();
    if (part !== undefined) yield { type: "assistant-message", id: assistantId, part };
  }

  // 何も書かずに終わったターンは、黙って終わらせない。
  // 本文も添付も注記も無ければ、ユーザーには何も届いていない。
  if (failure === null && !turn.stopped && !turn.controller.signal.aborted && !hasVisiblePart(parts)) {
    failure = "The model finished without writing a reply.";
  }

  if (failure === null) {
    if (finalMessage !== null) yield { type: "assistant-done", message: finalMessage };
    return;
  }

  // クライアントが離脱済みなら届け先が無いのでイベントにしない。
  if (!turn.controller.signal.aborted) {
    yield { type: "error", code: "model_error", detail: failure };
  }
}

/** ユーザーの目に触れる部分があるかどうか。 */
function hasVisiblePart(parts: readonly MessagePart[]): boolean {
  return parts.some(
    (part) =>
      (part.type === "text" && part.text.trim().length > 0) ||
      part.type === "attachment" ||
      part.type === "notice" ||
      // カードを出しただけのターンも、ユーザーの目には何かが届いている。
      (part.type === "tool-call" && toolNameFor(part.server, part.tool) === UI_TOOL_NAME),
  );
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

import type { ReplyLanguage } from "../../shared/language";
import { encodeChatEvent } from "../../shared/sse";
import type { ChatEvent, ChatMessage, MessagePart, TokenUsage } from "../../shared/types";
import { describeError } from "../../shared/errors";
import type { AgentEngine } from "./engine";
import type { Compaction } from "./compaction";
import type { Store } from "../data/store";

/**
 * 1 ターン分の流れ。
 * 保存 → モデル呼び出し → 保存、の順で進み、履歴は常に追記だけになる。
 */

/** ターンを流すのに必要なもの。 */
export type TurnDeps = {
  store: Store;
  engine: AgentEngine;
  /** 過去の対話の圧縮。ターンの前に走っている分を待ち、ターンの後に次を決める。 */
  compaction: Compaction;
};

/**
 * 1 ターン分のイベント列。終わったら、実行中の印を必ず外す。
 * 「停止」やタブの切断でジェネレータが閉じられた場合も、finally は通る。
 */
export async function* runTurn(
  deps: TurnDeps,
  teraId: string,
  content: string,
  language: ReplyLanguage,
  signal: AbortSignal,
  running: Set<string>,
): AsyncGenerator<ChatEvent> {
  try {
    yield* turnEvents(deps, teraId, content, language, signal);
  } finally {
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
  content: string,
  language: ReplyLanguage,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const { store, engine, compaction } = deps;

  // Tera は起動時に用意されている（無い id は、ここへ来る前に断っている）。
  const userMessage = store.appendMessage({
    id: crypto.randomUUID(),
    teraId,
    role: "user",
    content,
  });
  yield { type: "user-message", message: userMessage };

  const assistantId = crypto.randomUUID();
  yield { type: "assistant-start", id: assistantId, createdAt: Date.now() };

  // 畳んだ要約と、まだ畳んでいない生の履歴。生の履歴には要約も並べ替えもしない
  // （プロンプトキャッシュが当たり続けるようにするため）。
  // 走っている圧縮があれば、ここで終わるまで待つ（待っている間に止められたら、待ちをやめる）。
  const context = await compaction.context(teraId, signal);

  /** 生成中の本文とツールの出来事。保存される並びそのものになる。 */
  const parts: MessagePart[] = [];
  let usage: TokenUsage | null = null;
  let failure: string | null = null;
  let finalMessage: ChatMessage | null = null;

  const appendText = (delta: string): void => {
    const last = parts.at(-1);
    if (last?.type === "text") last.text += delta;
    else parts.push({ type: "text", text: delta });
  };

  /** ツールを使わなかったターンは、本文だけを持つ（parts 無し）メッセージにする。 */
  const storedParts = (): MessagePart[] | null => (parts.some((part) => part.type !== "text") ? parts : null);
  const storedText = (): string =>
    parts
      .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");

  /**
   * 生成済みの内容は、正常終了でも「停止」でも必ず保存する。
   * 停止時は呼び出し元がジェネレータを return するため、yield を含む後続のコードは実行されない。
   * だから保存だけは finally から呼べる形に切り出してある。
   * 何も生成しないまま失敗したときだけ、空のメッセージを作らない。
   */
  const persist = (): void => {
    if (finalMessage !== null) return;
    if (parts.length === 0 && failure !== null) return;

    finalMessage = store.appendMessage({
      id: assistantId,
      teraId,
      role: "assistant",
      content: storedText(),
      parts: storedParts(),
      usage,
    });
  };

  try {
    const stream = await engine.stream({ context, signal, teraId, replyLanguage: language });

    for await (const event of stream.events) {
      switch (event.type) {
        case "text-delta":
          appendText(event.delta);
          yield { type: "text-delta", id: assistantId, delta: event.delta };
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
          // 上限で打ち切られたことを本文の末尾に残す。画面でも次のターンのモデルでも分かるように。
          const note = stepLimitNote(language);
          appendText(note);
          yield { type: "text-delta", id: assistantId, delta: note };
          break;
        }
      }
    }

    usage = await stream.usage;
  } catch (error) {
    failure = describeError(error);
  } finally {
    persist();
  }

  if (failure === null && finalMessage !== null) {
    yield { type: "assistant-done", message: finalMessage };
    return;
  }

  // クライアントが離脱済みなら届け先が無いのでイベントにしない。
  if (failure !== null && !signal.aborted) {
    yield { type: "error", code: "model_error", detail: failure };
  }
}

/**
 * 待ちの接続に流す心拍の間隔。
 * Bun の待ち受けは、何も流さない接続を既定の 10 秒で切る（実測で 12 秒）。
 * ユーザーの操作を待つ間や、モデルが長く考えている間も切れないよう、これより短くする。
 */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** 何も流れない間に流すコメント行（SSE の仕様上、読む側は無視する）。 */
const HEARTBEAT_FRAME = ": heartbeat\n\n";

/**
 * 1 ターンのステップの上限で打ち切られたときに、本文の末尾へ足す注記。
 * 黙って切れると、応答が途中で終わった理由が画面から分からない。
 * 設定した返事の言語に合わせる。
 */
function stepLimitNote(language: ReplyLanguage): string {
  return language === "ja"
    ? "\n\n（1 回の応答で扱える操作の上限に達したため、ここで止まりました。続きは、もう一度送ってください）"
    : "\n\n(Stopped here because this turn reached the tool-call limit. Send another message to continue.)";
}

/**
 * クライアントが読むたびに、次のイベントを 1 つずつ返す。
 * pull ベースなので、相手が読まなくなれば cancel が呼ばれ、生成側も止まる。
 *
 * 次のイベントが来ないまま間隔が空いたら、コメント行を流して接続を保つ。
 * 止まった待ち（ユーザーの操作、長い思考）で切れないようにするため。
 * タイマーは待っている間だけ動かし、イベントが来たら必ず止める。
 */
export function sseResponse(events: AsyncGenerator<ChatEvent>): Response {
  const encoder = new TextEncoder();
  let pending: Promise<IteratorResult<ChatEvent>> | null = null;
  let heartbeat: ReturnType<typeof setTimeout> | null = null;

  function stopHeartbeat(): void {
    if (heartbeat === null) return;

    clearTimeout(heartbeat);
    heartbeat = null;
  }

  /** 心拍までの待ち。イベントが先に来ても、タイマーは stopHeartbeat が片付ける。 */
  function nextHeartbeat(): Promise<{ kind: "heartbeat" }> {
    return new Promise((resolve) => {
      heartbeat = setTimeout(() => resolve({ kind: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
    });
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // 前回の pull で待ち続けている分があれば、それをそのまま使う。
      pending ??= events.next();

      const outcome = await Promise.race([
        pending.then((result) => ({ kind: "event" as const, result })),
        nextHeartbeat(),
      ]);
      stopHeartbeat();

      // 相手が読むのをやめた直後は、流す先が無い。
      if (controller.desiredSize === null) return;

      if (outcome.kind === "heartbeat") {
        controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
        return;
      }

      pending = null;
      if (outcome.result.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(encodeChatEvent(outcome.result.value)));
    },
    async cancel() {
      stopHeartbeat();
      await events.return(undefined);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

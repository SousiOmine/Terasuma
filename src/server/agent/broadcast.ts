import type { ConversationEvent } from "../../shared/api/events";
import type { ChatEvent } from "../../shared/api/message";

/**
 * 同じ Tera を開いている、ほかの画面へターンの出来事を配る。
 *
 * 送った画面自身には配らない（その画面は、送信の応答として同じ出来事を受け取っている）。
 * 走っているターンの出来事はターンが終わるまで覚えておき、途中から購読した画面へも
 * 始まったところから流す。あとから開いた画面でも、いま書かれている内容が同じに見える。
 *
 * この仕組みはプロセスの中だけに閉じている。再起動で購読は切れるが、画面は繋ぎ直し、
 * 購読の最初に届く sync（最新の連番）から履歴を取り直すので、内容は揃う。
 */

/** 1 つの購読のために溜めておけるイベントの数。読み手が追いつかない購読は、ここで打ち切る。 */
const MAX_QUEUED_EVENTS = 1_000;

type Subscriber = {
  /** 購読している画面（タブ）の id。送った画面と同じなら、その出来事は配らない。 */
  clientId: string;
  /** まだ流していないイベント。 */
  queue: ConversationEvent[];
  /** イベントが届いて、待っている読み手を起こす。読み手がいなければ null。 */
  wake: (() => void) | null;
  /** 配るのをやめた（あふれた、または購読を畳んだ）。 */
  closed: boolean;
};

type Channel = {
  subscribers: Set<Subscriber>;
  /** 走っているターンの出来事。ターンが無いときは null。 */
  live: ChatEvent[] | null;
};

export type ConversationBroadcast = {
  /**
   * その Tera の出来事を受け取る。signal が立つか、読み手が離れるまで続く。
   * ターンが走っていれば、その始まりから流す。
   */
  subscribe(teraId: string, clientId: string, signal: AbortSignal): AsyncIterable<ConversationEvent>;
  /**
   * 送った画面へ流すイベントを、ほかの画面へも配りながら流す。
   * 送った画面が途中で離れて終わりを流せなかったときは、ほかの画面へ終わったことだけを配る。
   */
  relay(teraId: string, events: AsyncIterable<ChatEvent>, clientId: string): AsyncGenerator<ChatEvent>;
  /** ターンの外で保存した発言（応答中の割り込み）を、ほかの画面へ配る。 */
  publish(teraId: string, event: ChatEvent, exceptClientId: string): void;
};

export function createConversationBroadcast(): ConversationBroadcast {
  const channels = new Map<string, Channel>();

  function channelOf(teraId: string): Channel {
    const existing = channels.get(teraId);
    if (existing !== undefined) return existing;

    const created: Channel = { subscribers: new Set(), live: null };
    channels.set(teraId, created);
    return created;
  }

  /** 購読も走っているターンも無くなった Tera は、覚えておくのをやめる。 */
  function forgetIfIdle(teraId: string, channel: Channel): void {
    if (channel.subscribers.size > 0 || channel.live !== null) return;
    channels.delete(teraId);
  }

  function enqueue(subscriber: Subscriber, event: ConversationEvent): void {
    if (subscriber.closed) return;

    subscriber.queue.push(event);
    if (subscriber.queue.length > MAX_QUEUED_EVENTS) {
      // 読み手が追いつかない。繋いだまま溜め続けずに切る。画面は繋ぎ直し、
      // そのときの sync から履歴を取り直すので、内容は揃う。
      subscriber.closed = true;
      subscriber.queue.length = 0;
    }
    subscriber.wake?.();
  }

  function publish(teraId: string, event: ChatEvent, exceptClientId: string): void {
    const channel = channelOf(teraId);

    // 走っているターンの出来事は、途中から購読した画面へ流し直せるように覚えておく。
    if (event.type === "assistant-start") channel.live = [event];
    else if (isTurnEnd(event)) channel.live = null;
    else channel.live?.push(event);

    for (const subscriber of channel.subscribers) {
      if (subscriber.clientId === exceptClientId) continue;
      enqueue(subscriber, event);
    }
    forgetIfIdle(teraId, channel);
  }

  /** 終わりを流せないままターンが終わったことを、ほかの画面へ伝える。 */
  function publishTurnEnd(teraId: string, exceptClientId: string): void {
    const channel = channelOf(teraId);
    channel.live = null;

    for (const subscriber of channel.subscribers) {
      if (subscriber.clientId === exceptClientId) continue;
      enqueue(subscriber, { type: "turn-ended" });
    }
    forgetIfIdle(teraId, channel);
  }

  return {
    subscribe(teraId, clientId, signal) {
      const channel = channelOf(teraId);
      const subscriber: Subscriber = { clientId, queue: [], wake: null, closed: false };
      channel.subscribers.add(subscriber);

      // ターンの途中から購読しても、始まったところから見せる。
      // ここで控えを取る（このあとに配られる分は queue に入るので、二重にはならない）。
      const replay = [...(channel.live ?? [])];

      // 相手が読むのをやめたら、待ちを解いて購読を畳む。
      // 読み手のいない待ちは、次のイベントが来るまで解けないため、signal でも起こす。
      const onAbort = (): void => {
        subscriber.closed = true;
        subscriber.wake?.();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      return drain(subscriber, replay, () => {
        signal.removeEventListener("abort", onAbort);
        channel.subscribers.delete(subscriber);
        forgetIfIdle(teraId, channel);
      });
    },

    relay(teraId, events, clientId) {
      return relayTurn(
        events,
        (event) => publish(teraId, event, clientId),
        () => publishTurnEnd(teraId, clientId),
      );
    },

    publish,
  };
}

/** 控えたイベントを流し、そのあとは届いた順に流し続ける。 */
async function* drain(
  subscriber: Subscriber,
  replay: readonly ConversationEvent[],
  dispose: () => void,
): AsyncGenerator<ConversationEvent> {
  try {
    for (const event of replay) yield event;

    for (;;) {
      const event = subscriber.queue.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (subscriber.closed) return;

      await new Promise<void>((resolve) => {
        subscriber.wake = resolve;
      });
      subscriber.wake = null;
    }
  } finally {
    dispose();
  }
}

/** 送った画面へ流すイベントを、ほかの画面へも配りながら流す。 */
async function* relayTurn(
  events: AsyncIterable<ChatEvent>,
  publish: (event: ChatEvent) => void,
  endTurn: () => void,
): AsyncGenerator<ChatEvent> {
  let ended = false;
  try {
    for await (const event of events) {
      publish(event);
      if (isTurnEnd(event)) ended = true;
      yield event;
    }
  } finally {
    // 送った画面が途中で離れた（タブを閉じた、通信が切れた）。ターンはそこで終わる。
    // 終わりを伝えるイベントはもう流せないので、ほかの画面には終わったことだけを伝える。
    if (!ended) endTurn();
  }
}

/** ターンの終わりを伝えるイベントかどうか。 */
function isTurnEnd(event: ChatEvent): boolean {
  return event.type === "assistant-done" || event.type === "error";
}

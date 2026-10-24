import { signal } from "@preact/signals";
import type { ConversationEvent, ConversationSync } from "../../shared/api/events";
import type { ChatEvent, ChatMessageView, MessagePart } from "../../shared/api/message";
import { locale } from "../i18n";
import * as api from "../lib/api";
import { ApiError } from "../lib/http";
import { interpretEvent } from "./chat-events";
import { beginConnectorRequest, endConnectorRequest, resetConnectorRequest } from "./connector-request";
import { beginEnvRequest, endEnvRequest, resetEnvRequest } from "./env-request";
import { clearChatError, showChatError } from "./failure";
import { answerHandover, beginHandover, endHandover, handoverActive } from "./handover";
import { mergeLatestPage, mergeSaved, newestSavedSeq } from "./history";
import { activeTeraId, refreshTeras } from "./session";

/**
 * チャットの状態と、1 ターンの送信。
 *
 * 確定した会話は messages、いま届いているターンは liveTurn に置く。
 * ツールの呼び出しと結果は画面に出さないので持たない（引き受けの判定にだけ使う）。
 * 画面に出るのは、モデルの本文・添付・注記だけ。
 *
 * 同じ Tera を開いているほかの画面で起きたターンも、購読（streamConversation）から
 * 同じ形のイベントとして届く。どちらで起きたターンも、同じように状態へ反映する。
 */

export const messages = signal<readonly ChatMessageView[]>([]);

/** いま届いているターンの、画面に出す本文・添付・注記と、UI のカードの呼び出し。 */
export type LiveTurn = {
  id: string;
  createdAt: number;
  seq: number;
  parts: readonly MessagePart[];
};

export const liveTurn = signal<LiveTurn | null>(null);
export const isStreaming = signal(false);
/**
 * 発言を送った回数。画面はこれが増えるたびに、末尾へスクロールを寄せる。
 * 上へ遡って読んでいる途中でも、送った発言を見失わないようにするため。
 */
export const sentMessageCount = signal(0);
/** 停止を頼んで、ターンが止まるのを待っている。 */
export const isStopping = signal(false);
export const isLoadingMessages = signal(false);
/** さらに古いメッセージが残っているか。 */
export const hasOlderMessages = signal(false);
/** 古いメッセージを読んでいる最中か。 */
export const isLoadingOlderMessages = signal(false);

/** 1 回に読む履歴の件数。初回も、上端で古い履歴を足すときも同じ。 */
const MESSAGES_PAGE_SIZE = 20;

/**
 * 購読が切れたときに、繋ぎ直すまでの待ち。試すたびに倍にし、上限で止める。
 * 画面には理由を出さない。履歴は読めているので、繋がれば内容は揃う。
 */
const RESUBSCRIBE_DELAY_MS = 500;
const RESUBSCRIBE_MAX_DELAY_MS = 5_000;

/** 応答が終わりの合図なしに切れたときに、自動でやり直す回数。 */
const STREAM_RETRY_LIMIT = 1;

/** 読み込んだ中で最も古い seq。次に古いページを読むときの before。 */
let oldestSeq: number | null = null;

/**
 * 履歴を読み直すたびに進める番号。
 * 読んでいる間に Tera を切り替えたら、古い応答を捨てる。
 */
let messagesGeneration = 0;

/** いま繋いでいるターン。切り替えや停止で、古いターンの後始末が新しい状態を壊さないようにする。 */
type CurrentTurn = {
  teraId: string;
  controller: AbortController;
  /** 画面の後始末（liveTurn の確定と状態の更新）が終わったら解決する。 */
  done: Promise<void>;
};
let current: CurrentTurn | null = null;

/**
 * 新しい Tera を作る呼び出しの id（まだ結果が届いていないもの）。
 * 成功した結果が届いたら、サイドバーの一覧を読み直す。
 */
const teraCreateCalls = new Set<string>();

/** 同じ Tera を開いている、ほかの画面からの更新の購読。 */
let subscription: AbortController | null = null;

/**
 * 読み直しのたびに進める番号。
 * 読み直している間に次の読み直しが始まったら、古い応答は捨てる。
 */
let refreshGeneration = 0;

export async function openTera(id: string): Promise<void> {
  // 表示中のターンは捨てて、新しい Tera の履歴を読む。
  // サーバ側のターンは、接続が切れた時点でそれまでの内容を保存して終わる。
  closeSubscription();
  current?.controller.abort();
  current = null;
  liveTurn.value = null;
  isStreaming.value = false;
  isStopping.value = false;
  // 入力欄は、開いた Tera のターンのものだけを出す（前の Tera の待ちを残さない）。
  resetEnvRequest();
  resetConnectorRequest();
  teraCreateCalls.clear();
  clearChatError();
  activeTeraId.value = id;
  isLoadingMessages.value = true;
  isLoadingOlderMessages.value = false;
  hasOlderMessages.value = false;
  oldestSeq = null;

  const generation = ++messagesGeneration;
  try {
    const page = await api.listMessages(id, { limit: MESSAGES_PAGE_SIZE, before: null });
    // 読んでいる間に別の Tera を開いたら、この応答は捨てる。
    if (generation !== messagesGeneration) return;

    messages.value = page.messages;
    oldestSeq = page.messages[0]?.seq ?? null;
    hasOlderMessages.value = page.hasMore;
  } catch (error) {
    if (generation !== messagesGeneration) return;

    // 履歴を読めない Tera を開いたとき、前の履歴を残したままにすると
    // 見出しと本文が食い違う。空にして、理由を画面に出す。
    messages.value = [];
    showChatError(error);
  } finally {
    if (generation === messagesGeneration) {
      isLoadingMessages.value = false;
      // 履歴を読んだあとから購読を始める。読んでいる間にほかの画面で起きたことは、
      // 最初に届く sync（最新の連番）を見て取り直す。
      openSubscription(id, generation);
    }
  }
}

/** 購読を張る。前の Tera の購読は畳む。 */
function openSubscription(teraId: string, generation: number): void {
  closeSubscription();

  const controller = new AbortController();
  subscription = controller;
  void followConversation(teraId, generation, controller);
}

function closeSubscription(): void {
  subscription?.abort();
  subscription = null;
}

/**
 * 購読を張り、切れたら繋ぎ直す。
 * 届いたイベントは、ほかの画面で起きたターンの出来事として、そのまま状態へ反映する。
 */
async function followConversation(teraId: string, generation: number, controller: AbortController): Promise<void> {
  let attempt = 0;

  while (!controller.signal.aborted && generation === messagesGeneration) {
    try {
      for await (const event of api.streamConversation(teraId, controller.signal)) {
        // 1 つでも届いたら、次に切れたときはすぐ繋ぎ直す。
        attempt = 0;
        applyConversationEvent(teraId, event);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      // 消えた Tera を購読し続けても意味が無いので、繋ぎ直さずにやめる。
      if (error instanceof ApiError && error.code === "tera_not_found") return;
    }

    if (controller.signal.aborted || generation !== messagesGeneration) return;
    await delay(Math.min(RESUBSCRIBE_DELAY_MS * 2 ** attempt, RESUBSCRIBE_MAX_DELAY_MS));
    attempt += 1;
  }
}

/** 待ってから、次の繋ぎ直しを試す。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ほかの画面で起きたことを、この画面の状態へ反映する。 */
function applyConversationEvent(teraId: string, event: ConversationEvent): void {
  if (activeTeraId.value !== teraId) return;

  if (event.type === "sync") {
    applySync(teraId, event);
    return;
  }

  if (event.type === "turn-ended") {
    // 終わりを伝えるイベントは届かなかった（送った画面が途中で離れた）。それまでの内容は
    // 保存されているので、読み直して揃える。自分の送信は、送信の側で終わりを受け取っている。
    if (current === null) {
      finishRemoteTurn(teraId);
      void refreshLatest(teraId);
    }
    return;
  }

  applyEvent(event, teraId);

  // ほかの画面のターンが始まった。ここから終わりまで、応答中として扱う。
  if (current === null && (event.type === "user-message" || event.type === "assistant-start")) {
    isStreaming.value = true;
    isStopping.value = false;
  }

  // ほかの画面のターンが終わった。応答中の表示と、入力の待ちを畳む。
  if (current === null && (event.type === "assistant-done" || event.type === "error")) {
    finishRemoteTurn(teraId);
    // 失敗して終わったターンは assistant-done が届かない。保存された内容を読み直す。
    if (event.type === "error") void refreshLatest(teraId);
  }
}

/**
 * 購読を張った（張り直した）時点の状態へ、画面を合わせる。
 * 購読の切れている間に起きたことは、lastSeq を見て履歴から取り直す。
 */
function applySync(teraId: string, sync: ConversationSync): void {
  if (sync.turnRunning) {
    if (current === null) {
      // ほかの画面のターン。切れている間に変わった入力の待ちをいったん畳み、
      // 走っているターンの続きは、このあと流れてくるイベントで改めて出す。
      resetEnvRequest();
      resetConnectorRequest();
      liveTurn.value = null;
      isStreaming.value = true;
      isStopping.value = false;
    }
  } else if (current === null) {
    // 購読の切れている間に終わったターンも、ここで畳む。
    finishRemoteTurn(teraId);
  }

  if (sync.lastSeq > newestSavedSeq(messages.value)) void refreshLatest(teraId);
}

/** ほかの画面で走っていたターンが終わった。応答中の表示と、入力の待ちを畳む。 */
function finishRemoteTurn(teraId: string): void {
  // 終わりを受け取れなかったターンも、それまでの内容は画面に残す。
  settleLiveTurn(teraId);
  isStreaming.value = false;
  isStopping.value = false;
  resetEnvRequest();
  resetConnectorRequest();
}

/**
 * 保存されている最新のページを読み直し、手元の履歴へ重ねる。
 * 購読の切れている間に増えた分を、取り戻すために使う。
 */
async function refreshLatest(teraId: string): Promise<void> {
  // 別の Tera を開いているなら、取り直す先が違う（購読の切り替え中に呼ばれることがある）。
  if (activeTeraId.value !== teraId) return;

  const generation = ++refreshGeneration;
  try {
    const page = await api.listMessages(teraId, { limit: MESSAGES_PAGE_SIZE, before: null });
    if (generation !== refreshGeneration || activeTeraId.value !== teraId) return;

    const merged = mergeLatestPage(messages.value, page);
    messages.value = merged.messages;
    if (merged.resetOlder) {
      oldestSeq = page.messages[0]?.seq ?? null;
      hasOlderMessages.value = page.hasMore;
    }
  } catch (error) {
    // 取り直せなかった理由は、履歴の読み込みと同じく画面に出す。
    // もう一度必要になったとき（次に購読が切れたとき）に、また試す。
    if (generation === refreshGeneration && activeTeraId.value === teraId) showChatError(error);
  }
}

/**
 * さらに古いメッセージを 1 ページ読む。
 * 読み始めたかどうかを返す（画面は読む前にスクロール位置を控え、位置を保つ）。
 */
export function loadOlderMessages(): boolean {
  const teraId = activeTeraId.value;
  const before = oldestSeq;
  if (
    teraId === null ||
    before === null ||
    !hasOlderMessages.value ||
    isLoadingOlderMessages.value ||
    isLoadingMessages.value
  ) {
    return false;
  }

  isLoadingOlderMessages.value = true;
  void readOlderPage(teraId, before, messagesGeneration);
  return true;
}

/** 古いページを読み、いまの履歴の先頭へ足す。 */
async function readOlderPage(teraId: string, before: number, generation: number): Promise<void> {
  try {
    const page = await api.listMessages(teraId, { limit: MESSAGES_PAGE_SIZE, before });
    if (generation !== messagesGeneration) return;

    const oldest = page.messages[0];
    // 空のページを返す相手を読み続けない（hasMore と食い違っていても、古い側はもう無い）。
    if (oldest === undefined) {
      hasOlderMessages.value = false;
      return;
    }

    messages.value = [...page.messages, ...messages.value];
    oldestSeq = oldest.seq;
    hasOlderMessages.value = page.hasMore;
  } catch (error) {
    if (generation === messagesGeneration) showChatError(error);
  } finally {
    if (generation === messagesGeneration) isLoadingOlderMessages.value = false;
  }
}

export async function sendMessage(rawContent: string, files: readonly File[]): Promise<void> {
  const content = rawContent.trim();
  if (content.length === 0 && files.length === 0) return;

  // 送信は利用者の意思なので、上へ遡って読んでいても末尾へ戻す。
  sentMessageCount.value += 1;

  // 引き受けている間の入力は、新しい発言ではなくツールの戻り値になる。
  // 新しい発言として扱うと、ターンが 2 つ重なって会話の並びが崩れる。
  if (handoverActive.value) {
    if (content.length === 0) return;
    await answerHandover({ kind: "text", text: content });
    return;
  }

  // 送り先は起動時に読んだ一覧から決まる。読めていないときは送り先が無い。
  const teraId = activeTeraId.value;
  if (teraId === null) {
    showChatError(new ApiError("tera_not_found"));
    return;
  }

  // 応答を生成している間は、新しいターンを重ねず、走っているターンへ足す。
  // 足す先がちょうど終わっていたら、後始末が済んでから新しいターンとして送り直す。
  if (isStreaming.value) {
    const running = current;
    let steered: ChatMessageView | null;
    try {
      steered = await api.steerTurn(teraId, content, files);
    } catch (error) {
      showChatError(error);
      return;
    }
    // 待っている間に別の Tera へ切り替えたら、その発言は送らない。
    if (activeTeraId.value !== teraId) return;

    if (steered !== null) {
      clearChatError();
      upsertSaved(steered);
      return;
    }

    if (running === null) {
      // ほかの画面のターンは、こちらの送信より先に終わっていた。応答中の表示を畳んで、
      // 新しいターンとして送る。
      finishRemoteTurn(teraId);
    } else {
      // 自分のターンの後始末が済むまで待つ（待たずに始めると、古いターンの
      // assistant-done が新しいターンの表示を壊す）。
      await running.done;
      if (activeTeraId.value !== teraId) return;
      if (isStreaming.value) {
        // 待っている間に別のターンが始まった。重ねて始めず、理由を出す。
        showChatError(new ApiError("turn_in_progress"));
        return;
      }
    }
  }

  clearChatError();

  let outcome = await runTurn(
    teraId,
    (signal) => api.streamTurn(teraId, content, locale.value, files, signal),
    // 自動でやり直せるので、この時点ではまだ失敗として出さない。
    { reportStreamEnded: false },
  );

  for (let attempt = 0; attempt < STREAM_RETRY_LIMIT; attempt += 1) {
    if (outcome.ended || outcome.aborted) return;

    // 静かにやり直す。前の試行の失敗表示が残っていれば消す。
    clearChatError();
    outcome = await runTurn(teraId, (signal) => api.retryTurn(teraId, locale.value, signal), {
      reportStreamEnded: false,
    });
  }

  if (!outcome.ended && !outcome.aborted) showChatError(new ApiError("stream_ended"));
}

/** 画面へ応答を流し、そのターンの後始末まで行う。 */
type TurnOutcome = {
  /** 終わりを伝えるイベント（assistant-done / error）を受け取れたか。 */
  ended: boolean;
  /** 利用者の停止や画面の切り替えで、こちらから切ったか。 */
  aborted: boolean;
};

async function runTurn(
  teraId: string,
  request: (signal: AbortSignal) => AsyncGenerator<ChatEvent>,
  options: { reportStreamEnded?: boolean } = {},
): Promise<TurnOutcome> {
  const controller = new AbortController();
  let settle = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const turn: CurrentTurn = { teraId, controller, done };
  current = turn;
  isStreaming.value = true;
  isStopping.value = false;
  liveTurn.value = null;

  // ターンの終わりを伝えるイベントを受け取れたかどうか。
  let ended = false;
  try {
    for await (const event of request(controller.signal)) {
      applyEvent(event, teraId);
      if (event.type === "assistant-done" || event.type === "error") ended = true;
    }
  } catch (error) {
    showChatError(error);
  } finally {
    // タブを切り替えたあとに古いターンが終わっても、いまの画面は壊さない。
    if (current === turn) {
      settleLiveTurn(teraId);
      current = null;
      isStreaming.value = false;
      isStopping.value = false;
      // 結果が届かないまま（停止・切断で）ターンが終わった場合も、入力欄を残さない。
      resetEnvRequest();
      resetConnectorRequest();
    }
    settle();

    // 終わりを受け取れなかった。サーバはそれまでの内容を保存しているので、
    // 読み直して、仮置きを連番の付いた同じ発言へ置き換える。
    if (!ended) void refreshLatest(teraId);
  }

  const outcome = { ended, aborted: controller.signal.aborted };

  // 利用者の停止でも、終わりを伝えるイベントを受け取ったのでもないときは、
  // 応答が途中で切れたことを画面に出す。
  if (!outcome.ended && !outcome.aborted && options.reportStreamEnded !== false) {
    showChatError(new ApiError("stream_ended"));
  }
  return outcome;
}

/**
 * 最後のユーザー発言へ、もう一度答えてもらう。
 * 自動のやり直しも効かなかったときに、画面の「再試行」から呼ぶ。
 */
export async function retryLastTurn(): Promise<void> {
  const teraId = activeTeraId.value;
  if (teraId === null || isStreaming.value) return;

  clearChatError();
  await runTurn(teraId, (signal) => api.retryTurn(teraId, locale.value, signal));
}

/** 保存済みの発言を、seq の順に並ぶ位置へ入れる（同じ id があれば置き換える）。 */
function upsertSaved(message: ChatMessageView): void {
  messages.value = mergeSaved(messages.value, [message]);
}

/**
 * assistant-done を受け取れなかったターンを、画面に残す。
 *
 * サーバはそれまでの本文や添付を必ず保存しているので、読み直せば同じ内容が履歴から出る。
 * ここでは読み直すまでの間、同じ id・同じ seq の保存済みの発言として置いておく。
 */
function settleLiveTurn(teraId: string): void {
  const live = liveTurn.value;
  liveTurn.value = null;
  if (live === null || live.parts.length === 0) return;
  if (activeTeraId.value !== teraId) return;

  upsertSaved({
    id: live.id,
    teraId,
    seq: live.seq,
    role: "assistant",
    content: "",
    attachments: null,
    parts: [...live.parts],
    createdAt: live.createdAt,
  });
}

/**
 * 走っているターンを止める。SSE は閉じず、サーバがそれまでの内容を保存して
 * assistant-done を返すので、画面はそのまま確定した履歴へ移れる。
 */
export async function stopStreaming(): Promise<void> {
  const teraId = activeTeraId.value;
  if (teraId === null || !isStreaming.value || isStopping.value) return;

  isStopping.value = true;
  try {
    await api.stopTurn(teraId);
  } catch (error) {
    // 止められなかったので、ターンはそのまま続く。理由を出して、また押せるようにする。
    showChatError(error);
    isStopping.value = false;
  }
}

/** イベントを状態へ反映する。解釈は chat-events.ts が持つ。 */
function applyEvent(event: ChatEvent, teraId: string): void {
  const effect = interpretEvent(event);
  if (effect === null) return;

  switch (effect.kind) {
    case "message":
      // 保存された内容で置き換わるので、いま伸びていたターンは畳む。
      if (effect.message.role === "assistant" && liveTurn.value?.id === effect.message.id) liveTurn.value = null;
      upsertSaved(effect.message);
      break;
    case "assistant-start":
      // ステップが変わった。いまの吹き出しを確定させ、次の吹き出しを開く。
      settleLiveTurn(teraId);
      liveTurn.value = { id: effect.id, createdAt: effect.createdAt, seq: effect.seq, parts: [] };
      break;
    case "assistant-part": {
      const live = liveTurn.value;
      if (live === null) throw new Error(`ターンの開始前にメッセージが届きました（${effect.id}）`);
      liveTurn.value = { ...live, parts: [...live.parts, effect.part] };
      break;
    }
    case "chat-ui": {
      // カードの材料（ツール呼び出し）は、そのままターンの記録に積む。
      // 画面はここからマークアップを解釈して描く（保存する形は増やさない）。
      const live = liveTurn.value;
      if (live === null) throw new Error(`ターンの開始前に UI が届きました（${effect.part.id}）`);
      liveTurn.value = { ...live, parts: [...live.parts, effect.part] };
      break;
    }
    case "handover-start":
      beginHandover(effect.callId, effect.question);
      break;
    case "env-request-start":
      beginEnvRequest(effect.callId, effect.name, effect.description);
      break;
    case "connector-request-start":
      // Discord は Tera ごとの webhook なので、カードを出した時点の Tera を覚えておく。
      beginConnectorRequest(effect.callId, effect.provider, effect.reason, activeTeraId.value);
      break;
    case "tera-create-call":
      // 結果が成功で届いたときに、一覧を読み直す。
      teraCreateCalls.add(effect.callId);
      break;
    case "tool-result": {
      // 画面の引き受けは、成功したときだけ終える（失敗した呼び出しでは待ちが続いている）。
      if (!effect.failed) endHandover(effect.callId);
      // 環境変数の入力は、取り消しや失敗でも終える（入力を待ち続けない）。
      endEnvRequest(effect.callId);
      // 認証カードは、成功なら畳み、失敗は理由を残して導線を消さない。
      endConnectorRequest(effect.callId, effect.failed);
      // 新しい Tera ができたら、サイドバーへ出す（一覧を読み直す）。
      if (teraCreateCalls.delete(effect.callId) && !effect.failed) void refreshTeras().catch(showChatError);
      break;
    }
    case "error":
      showChatError(new ApiError(effect.code, effect.detail));
      break;
  }
}

import { signal } from "@preact/signals";
import type { ChatEvent, ChatMessageView, MessagePart } from "../../shared/api/message";
import { locale } from "../i18n";
import * as api from "../lib/api";
import { ApiError } from "../lib/http";
import { interpretEvent } from "./chat-events";
import { beginConnectionRequest, endConnectionRequest, resetConnectionRequest } from "./connection-request";
import { beginEnvRequest, endEnvRequest, resetEnvRequest } from "./env-request";
import { clearChatError, showChatError } from "./failure";
import { answerHandover, beginHandover, endHandover, handoverActive } from "./handover";
import { activeTeraId, refreshTeras } from "./session";

/**
 * チャットの状態と、1 ターンの送信。
 *
 * 確定した会話は messages、いま届いているターンは liveTurn に置く。
 * ツールの呼び出しと結果は画面に出さないので持たない（引き受けの判定にだけ使う）。
 * 画面に出るのは、モデルの本文・添付・注記だけ。
 */

export const messages = signal<readonly ChatMessageView[]>([]);

/** いま届いているターンの、画面に出す本文・添付・注記と、UI のカードの呼び出し。 */
export type LiveTurn = {
  id: string;
  createdAt: number;
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

export async function openTera(id: string): Promise<void> {
  // 表示中のターンは捨てて、新しい Tera の履歴を読む。
  // サーバ側のターンは、接続が切れた時点でそれまでの内容を保存して終わる。
  current?.controller.abort();
  current = null;
  liveTurn.value = null;
  isStreaming.value = false;
  isStopping.value = false;
  // 入力欄は、開いた Tera のターンのものだけを出す（前の Tera の待ちを残さない）。
  resetEnvRequest();
  resetConnectionRequest();
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
    if (generation === messagesGeneration) isLoadingMessages.value = false;
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
      insertSaved(steered);
      return;
    }

    // 最後のイベントを反映し終えるまで待つ（待たずに始めると、古いターンの
    // assistant-done が新しいターンの表示を壊す）。
    await running?.done;
    if (activeTeraId.value !== teraId) return;
    if (isStreaming.value) {
      // 待っている間に別のターンが始まった。重ねて始めず、理由を出す。
      showChatError(new ApiError("turn_in_progress"));
      return;
    }
  }

  clearChatError();

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

  try {
    for await (const event of api.streamTurn(teraId, content, locale.value, files, controller.signal)) {
      applyEvent(event);
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
      resetConnectionRequest();
    }
    settle();
  }
}

/**
 * 保存済みの発言を、seq の順に並ぶ位置へ入れる。
 *
 * 応答中に足した発言は、送っている間にターンが終わって assistant のメッセージが
 * 先に届くことがある。読み直したときと同じ並びになるよう、末尾ではなく seq の位置へ入れる。
 */
function insertSaved(message: ChatMessageView): void {
  const list = messages.value;
  const index = list.findIndex((entry) => entry.seq > message.seq);
  messages.value = index === -1 ? [...list, message] : [...list.slice(0, index), message, ...list.slice(index)];
}

/**
 * assistant-done を受け取れなかったターンを、画面に残す。
 *
 * サーバはそれまでの本文や添付を必ず保存しているので、読み直せば同じ内容が履歴から出る。
 * ここでは読み直すまでの間、同じ id のローカルのメッセージとして置いておく。
 * 保存された連番は読み直したときに付く（画面は配列の順に並べるので、ここでは使わない）。
 */
function settleLiveTurn(teraId: string): void {
  const live = liveTurn.value;
  liveTurn.value = null;
  if (live === null || live.parts.length === 0) return;
  if (activeTeraId.value !== teraId) return;

  messages.value = [
    ...messages.value,
    {
      id: live.id,
      teraId,
      seq: 0,
      role: "assistant",
      content: "",
      attachments: null,
      parts: [...live.parts],
      createdAt: live.createdAt,
    },
  ];
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
function applyEvent(event: ChatEvent): void {
  const effect = interpretEvent(event);
  if (effect === null) return;

  switch (effect.kind) {
    case "message":
      if (effect.message.role === "assistant") liveTurn.value = null;
      messages.value = [...messages.value, effect.message];
      break;
    case "assistant-start":
      liveTurn.value = { id: effect.id, createdAt: effect.createdAt, parts: [] };
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
    case "connection-request-start":
      // Discord は Tera ごとの webhook なので、カードを出した時点の Tera を覚えておく。
      beginConnectionRequest(effect.callId, effect.provider, effect.reason, activeTeraId.value);
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
      endConnectionRequest(effect.callId, effect.failed);
      // 新しい Tera ができたら、サイドバーへ出す（一覧を読み直す）。
      if (teraCreateCalls.delete(effect.callId) && !effect.failed) void refreshTeras().catch(showChatError);
      break;
    }
    case "error":
      showChatError(new ApiError(effect.code, effect.detail));
      break;
  }
}
